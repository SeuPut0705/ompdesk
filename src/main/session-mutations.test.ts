import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcErrorCode } from "../shared/ipc-error-codes";
import { deletedSessions, initDeletedSessions } from "./deleted-sessions";
import { deleteSession, type SessionTabs } from "./session-mutations";

beforeEach(() => {
	initDeletedSessions(null);
});

function tabs(closes: boolean) {
	const calls: string[] = [];
	const fake: SessionTabs = {
		sessionOwner: () => ({ tabId: "tab-a", winId: 1 }),
		sessionOwnerIsLive: () => true,
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
});
