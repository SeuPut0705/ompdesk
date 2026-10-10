import { describe, expect, it, vi } from "vitest";
import { GuiBridgeClient } from "../bridge-client";
import { handlers } from "./sessions";
import type { LocalCommandContext, LocalHandler } from "./types";

function context(cancelled: boolean, failTransition = false): { ctx: LocalCommandContext; calls: string[] } {
	const calls: string[] = [];
	const bridge = new GuiBridgeClient("");
	vi.spyOn(bridge, "request").mockImplementation(async <T>(method: string, params?: unknown): Promise<T> => {
		calls.push(method);
		expect(params).toEqual({ sessionPath: "/tmp/old.jsonl" });
		return null as T;
	});
	const ctx: LocalCommandContext = {
		cwd: "/tmp",
		omp: { bin: "omp", version: "18.8.7", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		bridge,
		emit: () => {},
		send: async <T>(command: { type: string }) => {
			calls.push(command.type);
			if (command.type === "get_state")
				return { sessionFile: "/tmp/old.jsonl", isStreaming: false, isCompacting: false } as T;
			if (failTransition) throw new Error("new session failed");
			return { cancelled } as T;
		},
	};
	return { ctx, calls };
}

const drop = handlers.drop_session as LocalHandler;
describe("drop_session stock deletion", () => {
	it("deletes only the old path after a successful new_session", async () => {
		const { ctx, calls } = context(false);
		expect(await drop({ type: "drop_session" }, ctx)).toEqual({ cancelled: false });
		expect(calls).toEqual(["get_state", "new_session", "sessions.delete"]);
	});

	it("does not delete when stock cancels the transition", async () => {
		const { ctx, calls } = context(true);
		expect(await drop({ type: "drop_session" }, ctx)).toEqual({ cancelled: true });
		expect(calls).toEqual(["get_state", "new_session"]);
	});

	it("does not delete when new_session fails", async () => {
		const { ctx, calls } = context(false, true);
		await expect(drop({ type: "drop_session" }, ctx)).rejects.toThrow("new session failed");
		expect(calls).toEqual(["get_state", "new_session"]);
	});
});
