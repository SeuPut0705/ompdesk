import { describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../shared/rpc-types";
import { deleteSession, type SessionTabs } from "./session-mutations";

function tabs(
	live: boolean,
	response: RpcResponse | null = {
		type: "response",
		command: "drop_session",
		success: true,
		data: { cancelled: false },
	},
) {
	const calls: string[] = [];
	const fake: SessionTabs = {
		sessionOwner: () => ({ tabId: "tab-a", winId: 1 }),
		sessionOwnerIsLive: () => live,
		commandForSession: vi.fn(async () => null),
		commandForIdleSession: vi.fn(async (_path, command) => {
			calls.push(command.type);
			return response;
		}),
		forgetSession: (tabId, sessionPath) => {
			calls.push(`forget ${tabId} ${sessionPath}`);
		},
	};
	return { fake, calls };
}

describe("deleteSession", () => {
	it("a tab holding the session live drops it, then forgets the deleted session's identity", async () => {
		const { fake, calls } = tabs(true);
		const deleteStored = vi.fn(async () => {});
		await deleteSession(fake, "/s/a.jsonl", undefined, deleteStored);
		expect(calls).toEqual(["drop_session", "forget tab-a /s/a.jsonl"]);
		expect(deleteStored).not.toHaveBeenCalled();
	});

	it("a tab without a process forgets the session (file, id, title), then the stored file is deleted", async () => {
		const { fake, calls } = tabs(false);
		const deleteStored = vi.fn(async () => {
			calls.push("deleteStored");
		});
		await deleteSession(fake, "/s/a.jsonl", undefined, deleteStored);
		expect(calls).toEqual(["forget tab-a /s/a.jsonl", "deleteStored"]);
	});

	it("a cancelled drop keeps the tab's session", async () => {
		const cancelled: RpcResponse = {
			type: "response",
			command: "drop_session",
			success: true,
			data: { cancelled: true },
		};
		const { fake, calls } = tabs(true, cancelled);
		await expect(deleteSession(fake, "/s/a.jsonl", undefined, async () => {})).rejects.toThrow("cancelled");
		expect(calls).toEqual(["drop_session"]);
	});
});
