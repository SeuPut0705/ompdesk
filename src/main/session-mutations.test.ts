import { describe, expect, it, vi } from "vitest";
import { ipcErrorCode } from "../shared/ipc-error-codes";
import { deleteSession, type SessionTabs } from "./session-mutations";

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
	});

	it("refuses while the holding tab runs a turn or compacts, and keeps the file", async () => {
		const { fake, calls } = tabs(false);
		const deleteStored = vi.fn(async () => {});
		const refused = await deleteSession(fake, "/s/a.jsonl", undefined, deleteStored).catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		expect(calls).toEqual(["close /s/a.jsonl local"]);
		expect(deleteStored).not.toHaveBeenCalled();
	});
});
