import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codedError, ipcErrorCode } from "../shared/ipc-error-codes";
import { deletedSessions, initDeletedSessions } from "./deleted-sessions";
import { deleteSession, recordSessionDelete, type SessionTabs, setSessionDeleteLog } from "./session-mutations";

beforeEach(() => {
	initDeletedSessions(null);
});

function tabs(closes: boolean, running = false) {
	const calls: string[] = [];
	const fake: SessionTabs = {
		sessionOwner: () => ({ tabId: "tab-a", winId: 1 }),
		sessionOwnerIsLive: () => true,
		sessionRunning: () => running,
		commandForSession: vi.fn(async () => null),
		closeSessionTab: vi.fn(async (sessionPath: string, device?: string) => {
			calls.push(`close ${sessionPath} ${device ?? "local"}`);
			return closes;
		}),
	};
	return { fake, calls };
}

describe("deleteSession", () => {
	it("closes the tab holding the session (and waits for its omp), then deletes the stored file: no new session", async () => {
		const { fake, calls } = tabs(true);
		const deleteStored = vi.fn(async () => {
			calls.push("deleteStored");
		});
		await deleteSession(fake, "/s/a.jsonl", "host-b", deleteStored);
		expect(calls).toEqual(["close /s/a.jsonl host-b", "deleteStored"]);
		// Nothing asks any omp for a replacement session.
		expect(fake.commandForSession).not.toHaveBeenCalled();
		// Remembered as deleted on that device only, so no restore path anywhere brings it back.
		expect(deletedSessions().has("/s/a.jsonl", "host-b")).toBe(true);
		expect(deletedSessions().has("/s/a.jsonl")).toBe(false);
	});

	it("refuses while the holding tab runs a turn or compacts, and keeps the file", async () => {
		const { fake, calls } = tabs(false);
		const deleteStored = vi.fn(async () => {});
		const refused = await deleteSession(fake, "/s/a.jsonl", undefined, deleteStored).catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		expect(calls).toEqual(["close /s/a.jsonl local"]);
		expect(deleteStored).not.toHaveBeenCalled();
		expect(deletedSessions().has("/s/a.jsonl")).toBe(false);
	});

	it("records nothing when the stored delete fails (the session is still there)", async () => {
		const { fake } = tabs(true);
		await expect(
			deleteSession(fake, "/s/b.jsonl", undefined, async () => {
				throw new Error("disk");
			}),
		).rejects.toThrow("disk");
		expect(deletedSessions().has("/s/b.jsonl")).toBe(false);
	});

	it("keeps its record across a relaunch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "deleted-sessions-"));
		const file = join(dir, "deleted-sessions.json");
		initDeletedSessions(file);
		await deleteSession(tabs(true).fake, "/s/c.jsonl", undefined, async () => {});
		expect(initDeletedSessions(file).has("/s/c.jsonl")).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	it("this computer's own delete closes the devices' idle tabs on it first, never while its own tab runs", async () => {
		const { fake, calls } = tabs(true);
		const deviceTabs = {
			closeSessionTabs: vi.fn(async (sessionPath: string) => {
				calls.push(`devices ${sessionPath}`);
			}),
		};
		await deleteSession(fake, "/s/d.jsonl", undefined, async () => void calls.push("deleteStored"), deviceTabs);
		expect(calls).toEqual(["devices /s/d.jsonl", "close /s/d.jsonl local", "deleteStored"]);

		// A window's own tab runs: nothing is closed anywhere, no device is told the session went.
		const busy = tabs(true, true);
		deviceTabs.closeSessionTabs.mockClear();
		const refused = await deleteSession(busy.fake, "/s/e.jsonl", undefined, async () => {}, deviceTabs).catch(
			(error: unknown) => error,
		);
		expect(ipcErrorCode(refused)).toBe("session_running");
		expect(deviceTabs.closeSessionTabs).not.toHaveBeenCalled();
		expect(busy.calls).toEqual([]);
	});
});

describe("recordSessionDelete", () => {
	it("writes one line per delete: the device, the file's name, and the outcome or the refusal", async () => {
		const lines: Array<{ outcome: string; details: Record<string, string> }> = [];
		setSessionDeleteLog((outcome, details) => lines.push({ outcome, details }));
		await recordSessionDelete({ sessionPath: "/home/u/.omp/agent/sessions/x/2026_abc.jsonl" }, async () => {});
		const refused = await recordSessionDelete(
			{ sessionPath: "C:\\Users\\admin\\.omp\\sessions\\b.jsonl", device: "desk", by: "mac" },
			async () => {
				throw codedError("session_running", "Session is currently running");
			},
		).catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		const failed = await recordSessionDelete({ sessionPath: "/s/f.jsonl" }, async () => {
			throw new Error("disk full");
		}).catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(Error);
		expect(lines).toEqual([
			{ outcome: "deleted", details: { device: "local", session: "2026_abc.jsonl" } },
			{ outcome: "refused", details: { device: "desk", by: "mac", session: "b.jsonl", reason: "session_running" } },
			{ outcome: "failed", details: { device: "local", session: "f.jsonl", reason: "disk full" } },
		]);
		setSessionDeleteLog(null);
	});
});
