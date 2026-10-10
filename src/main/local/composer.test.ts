import { describe, expect, it } from "vitest";
import { handlers } from "./composer";
import { type BridgeClient, type LocalCommandContext, LocalCommandError } from "./types";

const STOCK_STATE = { sessionId: "s1", sessionFile: "/s/1.jsonl", thinkingLevel: "high", isStreaming: false };

function fakeContext(
	options: { bridge?: Record<string, unknown>; stock?: Record<string, unknown>; connected?: boolean } = {},
): LocalCommandContext {
	const stock: Record<string, unknown> = {
		get_state: STOCK_STATE,
		get_available_thinking_levels: { levels: ["off", "low", "high"] },
		...options.stock,
	};
	const bridge: BridgeClient = {
		connected: options.connected ?? true,
		async request<T>(method: string): Promise<T> {
			if (!options.bridge || !Object.hasOwn(options.bridge, method)) throw new Error(`no ${method}`);
			return options.bridge[method] as T;
		},
		onEvent: () => () => {},
	};
	return {
		cwd: "/spawn",
		omp: { bin: "omp", version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		async send<T>(command: { type: string }): Promise<T> {
			if (!Object.hasOwn(stock, command.type)) throw new Error(`unexpected stock ${command.type}`);
			return stock[command.type] as T;
		},
		bridge,
		emit: () => {},
	};
}

describe("get_state", () => {
	it("adds the bridge extras to stock state and drops `off` from the reasoning levels", async () => {
		const ctx = fakeContext({
			bridge: {
				"composer.state": {
					cwd: "/moved",
					autoRetryEnabled: false,
					thinkingConfigured: "auto",
					planModeEnabled: true,
					prewalkArmed: true,
					agentsPaused: true,
					agentsPausedAt: 42,
				},
			},
		});
		await expect(handlers.get_state({ type: "get_state" }, ctx)).resolves.toEqual({
			...STOCK_STATE,
			cwd: "/moved",
			autoRetryEnabled: false,
			thinkingConfigured: "auto",
			availableThinkingLevels: ["low", "high"],
			planModeEnabled: true,
			prewalkArmed: true,
			agentsPaused: true,
			agentsPausedAt: 42,
		});
	});

	it("still answers with safe defaults when the bridge is down", async () => {
		const state = await handlers.get_state({ type: "get_state" }, fakeContext({ connected: false }));
		expect(state).toMatchObject({
			sessionId: "s1",
			cwd: "/spawn",
			autoRetryEnabled: true,
			thinkingConfigured: "high",
			planModeEnabled: false,
			prewalkArmed: false,
			agentsPaused: false,
		});
		expect(state).not.toHaveProperty("agentsPausedAt");
	});

	it("survives a failing bridge method", async () => {
		const state = await handlers.get_state({ type: "get_state" }, fakeContext({ bridge: {} }));
		expect(state).toMatchObject({ cwd: "/spawn", agentsPaused: false });
	});
});

describe("stock composer authority", () => {
	it("keeps forward cycling on stock RPC and only routes backward through the bridge", async () => {
		const ctx = fakeContext({
			stock: { cycle_model: { model: { id: "forward" } } },
			bridge: { "composer.cycle_model_backward": { model: { id: "backward" } } },
		});
		await expect(handlers.cycle_model({ type: "cycle_model" }, ctx)).resolves.toEqual({ model: { id: "forward" } });
		await expect(handlers.cycle_model({ type: "cycle_model", direction: "forward" }, ctx)).resolves.toEqual({
			model: { id: "forward" },
		});
		await expect(handlers.cycle_model({ type: "cycle_model", direction: "backward" }, ctx)).resolves.toEqual({
			model: { id: "backward" },
		});
	});

	it("reads the resolved thinking level from get_state, not composer extras", async () => {
		const ctx = fakeContext({
			stock: { set_thinking_level: {} },
			bridge: { "composer.state": { thinkingConfigured: "auto", thinkingLevel: "low" } },
		});
		await expect(handlers.set_thinking_level({ type: "set_thinking_level", level: "auto" }, ctx)).resolves.toEqual({
			thinkingLevel: "high",
			thinkingConfigured: "auto",
		});
	});

	it("uses stock tool descriptions and retains provenance plus mounted tools", async () => {
		const ctx = fakeContext({
			stock: { get_state: { ...STOCK_STATE, dumpTools: [{ name: "read", description: "Stock description" }] } },
			bridge: {
				"composer.tool_extras": {
					sources: { read: "builtin" },
					mounted: [{ name: "xd://tool", description: "Mounted", source: "extension" }],
				},
			},
		});
		await expect(handlers.get_active_tools({ type: "get_active_tools" }, ctx)).resolves.toEqual({
			tools: [
				{ name: "read", description: "Stock description", source: "builtin" },
				{ name: "xd://tool", description: "Mounted", source: "extension" },
			],
		});
	});
});

describe("composer actions", () => {
	it("maps stock job items onto the renderer's job shape", async () => {
		const ctx = fakeContext({
			bridge: {
				"composer.jobs": [
					{ id: "j1", type: "bash", status: "running", label: "sleep", startTime: 1, command: "sleep 9" },
					{ id: "j2", type: "task", status: "completed", label: "t", startTime: 2, endTime: 5, agentId: "a" },
				],
			},
		});
		await expect(handlers.get_jobs({ type: "get_jobs" }, ctx)).resolves.toEqual({
			jobs: [
				{ id: "j1", type: "bash", status: "running", label: "sleep", startTime: 1 },
				{ id: "j2", type: "task", status: "completed", label: "t", startTime: 2, endedAt: 5, agentId: "a" },
			],
		});
	});

	it("refuses /fresh with code busy while streaming", async () => {
		const ctx = fakeContext({ stock: { get_state: { ...STOCK_STATE, isStreaming: true } } });
		const refusal = handlers.fresh({ type: "fresh" }, ctx);
		await expect(refusal).rejects.toBeInstanceOf(LocalCommandError);
		await expect(refusal).rejects.toMatchObject({ code: "busy" });
	});

	it("maps a refused context reset to code busy", async () => {
		const ctx = fakeContext({ bridge: { "composer.clear_context": null } });
		await expect(handlers.clear_context({ type: "clear_context" }, ctx)).rejects.toMatchObject({ code: "busy" });
	});

	it("takes exactly one of tool or clear for set_force_tool", async () => {
		const ctx = fakeContext();
		await expect(handlers.set_force_tool({ type: "set_force_tool" }, ctx)).rejects.toThrow(/exactly one/);
		await expect(handlers.set_force_tool({ type: "set_force_tool", tool: "read", clear: true }, ctx)).rejects.toThrow(
			/exactly one/,
		);
	});
});
