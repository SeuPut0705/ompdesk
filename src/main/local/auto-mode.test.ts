import { describe, expect, it, vi } from "vitest";
import type { AutoModeDecision } from "../../../resources/gui-bridge/modes/auto-mode-contracts";
import { handlers } from "./auto-mode";
import { localHandlerFor } from "./index";
import type { LocalCommandContext } from "./types";

/** A context whose bridge answers `modes.auto_mode_decide` with `decision`, recording every bridge and stock call. */
function fakeCtx(decision?: Partial<AutoModeDecision>) {
	const calls: Array<{ to: "bridge" | "stock"; what: unknown }> = [];
	const ctx: LocalCommandContext = {
		cwd: "/repo",
		omp: { bin: "omp", version: "18.11.0", run: vi.fn() },
		send: vi.fn(async (command: { type: string }) => {
			calls.push({ to: "stock", what: command });
			return {};
		}) as LocalCommandContext["send"],
		bridge: {
			request: vi.fn(async (method: string, params?: unknown) => {
				calls.push({ to: "bridge", what: { method, params } });
				return method === "modes.auto_mode_decide" ? decision : {};
			}) as LocalCommandContext["bridge"]["request"],
			onEvent: vi.fn(() => () => {}),
			connected: true,
		},
	};
	return { ctx, calls };
}

function run(type: string, params: Record<string, unknown>, ctx: LocalCommandContext): Promise<unknown> {
	const handler = handlers[type];
	if (!handler) throw new Error(`no handler for ${type}`);
	return handler({ type, ...params }, ctx);
}

describe("automatic mode commands", () => {
	it("are served locally", () => {
		for (const type of ["auto_mode_decide", "auto_mode_undo", "auto_mode_end"]) {
			expect(localHandlerFor(type), type).toBe(handlers[type]);
		}
	});

	it("a plan decision enters stock's plan mode marked automatic", async () => {
		const { ctx, calls } = fakeCtx({ mode: "plan" });
		await run("auto_mode_decide", { message: "refactor everything" }, ctx);
		expect(calls).toEqual([
			{ to: "bridge", what: { method: "modes.auto_mode_decide", params: { message: "refactor everything" } } },
			{ to: "bridge", what: { method: "modes.set_plan_mode", params: { enabled: true, auto: true } } },
		]);
	});

	it("a goal decision creates stock's goal with the objective; no plan mode", async () => {
		const { ctx, calls } = fakeCtx({ mode: "goal", objective: "all tests pass" });
		await run("auto_mode_decide", { message: "keep going until all the tests pass" }, ctx);
		expect(calls.slice(1)).toEqual([
			{ to: "stock", what: { type: "goal", op: "create", objective: "all tests pass" } },
		]);
	});

	it("a none decision changes nothing", async () => {
		const { ctx, calls } = fakeCtx({ mode: "none", reason: "busy" });
		await expect(run("auto_mode_decide", { message: "next" }, ctx)).resolves.toMatchObject({ mode: "none" });
		expect(calls).toHaveLength(1);
	});

	it("ending an automatic plan leaves plan mode through stock's exit, with no undo (later prompts stay classified)", async () => {
		const { ctx, calls } = fakeCtx();
		await run("auto_mode_end", { mode: "plan" }, ctx);
		expect(calls).toEqual([{ to: "bridge", what: { method: "modes.set_plan_mode", params: { enabled: false } } }]);
	});

	it("ending an automatic goal drops stock's goal", async () => {
		const { ctx, calls } = fakeCtx();
		await run("auto_mode_end", { mode: "goal" }, ctx);
		expect(calls).toEqual([{ to: "stock", what: { type: "goal", op: "drop" } }]);
	});

	it("the chip's undo of a goal stops deciding for the session, then drops the goal", async () => {
		const { ctx, calls } = fakeCtx();
		await run("auto_mode_undo", { mode: "goal" }, ctx);
		expect(calls).toEqual([
			{ to: "bridge", what: { method: "modes.auto_mode_undo", params: { mode: "goal" } } },
			{ to: "stock", what: { type: "goal", op: "drop" } },
		]);
	});
});
