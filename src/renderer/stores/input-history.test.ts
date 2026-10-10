import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionRpcClient } from "../../shared/rpc-client";
import type { RpcResponse } from "../../shared/rpc-types";
import { useInputHistoryStore } from "./input-history";
import { useToastStore } from "./toast";

beforeEach(() => {
	useInputHistoryStore.setState({ entries: [], hydrated: false, navIndex: -1, navDraft: "", navContext: undefined });
});

function installHistory(legacy: unknown = undefined) {
	let stored = legacy;
	const history: Array<{ prompt: string; created_at: number; cwd?: string }> = [];
	const command = vi.fn(
		async (input: { type: string; prompt?: string; cwd?: string; query?: string }): Promise<RpcResponse> => {
			let data: unknown;
			if (input.type === "history_record") {
				const prompt = input.prompt ?? "";
				const skipped = prompt.startsWith("/login:");
				if (!skipped) history.unshift({ prompt, created_at: Date.now() / 1000, cwd: input.cwd });
				data = { skipped };
			} else data = history;
			return { type: "response", command: input.type, success: true, data };
		},
	);
	const rpc = createSessionRpcClient(command);
	const prefs = {
		get: vi.fn(async () => stored),
		set: vi.fn(async (_key: string, value: unknown) => {
			stored = value;
		}),
	};
	(globalThis as Record<string, unknown>).window = { omp: { rpc, prefs } };
	return { rpc, prefs, history, command };
}

describe("stock prompt history adapter", () => {
	it("imports legacy prefs oldest-first and deletes the copy only after success", async () => {
		const { rpc, prefs, history } = installHistory([{ prompt: "new", ts: 2, cwd: "/repo" }, "old", "/login:secret"]);
		await useInputHistoryStore.getState().hydrate(rpc);
		expect(history.map(entry => entry.prompt)).toEqual(["new", "old"]);
		expect(prefs.set).toHaveBeenCalledWith("inputHistory", undefined);
		await useInputHistoryStore.getState().hydrate(rpc);
		expect(history).toHaveLength(2);
	});
	it("retains legacy prefs if stock rejects migration", async () => {
		const { rpc, prefs, command } = installHistory(["old"]);
		command.mockResolvedValueOnce({
			type: "response",
			command: "history_record",
			success: false,
			error: "unavailable",
		});
		await useInputHistoryStore.getState().hydrate(rpc);
		expect(prefs.set).not.toHaveBeenCalled();
	});
	it("keeps stock-skipped secrets transient and restores the draft on Down", async () => {
		const { rpc, history } = installHistory();
		const state = useInputHistoryStore.getState();
		state.record("/login:secret", "/repo", rpc);
		await vi.waitFor(() => expect(history).toHaveLength(0));
		expect(state.prev("draft", { cwd: "/repo", owner: "local" })).toBe("/login:secret");
		expect(state.next({ cwd: "/repo", owner: "local" })).toBe("draft");
		await state.hydrate(rpc);
		expect(useInputHistoryStore.getState().entries[0]?.transient).toBe(true);
	});
	it("uses host history for remote tabs without migrating client prefs", async () => {
		const { rpc, prefs, history } = installHistory(["client-only"]);
		history.push({ prompt: "host", created_at: 1, cwd: "/repo" });
		await useInputHistoryStore.getState().hydrate(rpc, "host-device");
		expect(prefs.get).not.toHaveBeenCalled();
		expect(
			useInputHistoryStore.getState().prev("draft", { cwd: "/repo", owner: "remote", device: "host-device" }),
		).toBe("host");
		expect(useInputHistoryStore.getState().prev("draft", { cwd: "/repo", owner: "local" })).toBeUndefined();
	});
	it("delegates query and workspace filtering to stock search", async () => {
		const { rpc, command } = installHistory();
		await useInputHistoryStore.getState().search("git-commit", 50, "/repo", rpc);
		expect(command).toHaveBeenCalledWith(
			{ type: "history_search", query: "git-commit", limit: 50, cwd: "/repo" },
			undefined,
		);
	});
	it("keeps a prompt whose history write failed recallable, without a failure toast", async () => {
		const { rpc, command } = installHistory();
		command.mockRejectedValueOnce(new Error("RPC timeout (8000ms): history_record"));
		useInputHistoryStore.getState().record("ship it", "/repo", rpc);
		await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
		await Promise.resolve();
		expect(useToastStore.getState().toasts).toEqual([]);
		expect(useInputHistoryStore.getState().prev("draft", { cwd: "/repo", owner: "local" })).toBe("ship it");
	});
});
