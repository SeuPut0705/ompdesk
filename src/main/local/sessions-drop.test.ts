import { describe, expect, it, vi } from "vitest";
import { GuiBridgeClient } from "../bridge-client";
import { handlers } from "./sessions";
import type { LocalCommandContext, LocalHandler } from "./types";

function context(cancelled: boolean, failTransition = false): { ctx: LocalCommandContext; calls: string[] } {
	const calls: string[] = [];
	// Stock's live session: new_session moves it to a fresh file, as omp ≥ 18.11 writes at once.
	let live = "/tmp/old.jsonl";
	const bridge = new GuiBridgeClient("");
	vi.spyOn(bridge, "request").mockImplementation(async <T>(method: string, params?: unknown): Promise<T> => {
		const sessionPath =
			typeof params === "object" && params !== null && "sessionPath" in params ? params.sessionPath : undefined;
		calls.push(`${method} ${String(sessionPath)}`);
		return null as T;
	});
	const ctx: LocalCommandContext = {
		cwd: "/tmp",
		omp: { bin: "omp", version: "18.8.7", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		bridge,
		send: async <T>(command: { type: string }) => {
			if (command.type === "get_state") {
				calls.push(`get_state ${live}`);
				return { sessionFile: live, isStreaming: false, isCompacting: false } as T;
			}
			calls.push(command.type);
			if (failTransition) throw new Error("new session failed");
			if (!cancelled) live = "/tmp/new.jsonl";
			return { cancelled } as T;
		},
	};
	return { ctx, calls };
}

const drop = handlers.drop_session as LocalHandler;
describe("drop_session stock deletion", () => {
	it("reports the replacement session to main, then deletes only the old path", async () => {
		const { ctx, calls } = context(false);
		expect(await drop({ type: "drop_session" }, ctx)).toEqual({ cancelled: false });
		// The second get_state is what moves main's tab identity (file, id, title) off the deleted session.
		expect(calls).toEqual([
			"get_state /tmp/old.jsonl",
			"new_session",
			"get_state /tmp/new.jsonl",
			"sessions.delete /tmp/old.jsonl",
		]);
	});

	it("does not delete when stock cancels the transition", async () => {
		const { ctx, calls } = context(true);
		expect(await drop({ type: "drop_session" }, ctx)).toEqual({ cancelled: true });
		expect(calls).toEqual(["get_state /tmp/old.jsonl", "new_session"]);
	});

	it("does not delete when new_session fails", async () => {
		const { ctx, calls } = context(false, true);
		await expect(drop({ type: "drop_session" }, ctx)).rejects.toThrow("new session failed");
		expect(calls).toEqual(["get_state /tmp/old.jsonl", "new_session"]);
	});
});
