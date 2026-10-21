import { describe, expect, it } from "vitest";
import type { SidecarStatus } from "../shared/rpc-types";
import { EMPTY_APPLY_PLAN, extensionApplyDecision, mergeApplyPlans, planIsEmpty } from "./extension-reload";

describe("mergeApplyPlans", () => {
	it("ors the flags and unions the reconnect names in first-seen order", () => {
		expect(
			mergeApplyPlans(
				{ reload: true, restart: false, reconnect: ["a", "b"] },
				{ reload: false, restart: true, reconnect: ["b", "c"] },
			),
		).toEqual({ reload: true, restart: true, reconnect: ["a", "b", "c"] });
	});

	it("keeps an empty plan empty and does not mutate its inputs", () => {
		const a = { reload: false, restart: false, reconnect: ["x"] };
		expect(mergeApplyPlans(EMPTY_APPLY_PLAN, EMPTY_APPLY_PLAN)).toEqual(EMPTY_APPLY_PLAN);
		mergeApplyPlans(a, { reload: true, restart: false, reconnect: ["y"] });
		expect(a.reconnect).toEqual(["x"]);
		expect(EMPTY_APPLY_PLAN.reconnect).toEqual([]);
	});

	it("unions the MCP servers another session changed, and a reload of all of them wins", () => {
		const plan = (names: string[], all?: boolean) => ({
			...EMPTY_APPLY_PLAN,
			mcp: { names, ...(all ? { all } : {}) },
		});
		expect(mergeApplyPlans(plan(["a"]), plan(["a", "b"])).mcp).toEqual({ names: ["a", "b"] });
		expect(mergeApplyPlans(plan(["a"]), plan([], true)).mcp).toEqual({ names: [], all: true });
		expect(mergeApplyPlans(EMPTY_APPLY_PLAN, plan(["a"])).mcp).toEqual({ names: ["a"] });
		expect(mergeApplyPlans(EMPTY_APPLY_PLAN, EMPTY_APPLY_PLAN)).not.toHaveProperty("mcp");
		expect(planIsEmpty(plan(["a"]))).toBe(false);
	});
});

describe("planIsEmpty", () => {
	it("is true only when nothing is to apply", () => {
		expect(planIsEmpty(EMPTY_APPLY_PLAN)).toBe(true);
		expect(planIsEmpty({ reload: true, restart: false, reconnect: [] })).toBe(false);
		expect(planIsEmpty({ reload: false, restart: true, reconnect: [] })).toBe(false);
		expect(planIsEmpty({ reload: false, restart: false, reconnect: ["a"] })).toBe(false);
	});
});

describe("extensionApplyDecision", () => {
	const table: Array<[SidecarStatus, boolean, "now" | "wait" | "skip"]> = [
		["asleep", false, "skip"],
		["asleep", true, "skip"],
		["starting", false, "skip"],
		["starting", true, "skip"],
		["error", false, "skip"],
		["error", true, "skip"],
		["ready", false, "now"],
		["ready", true, "wait"],
		["restarting", false, "skip"],
		["exited", false, "skip"],
		["restarting", true, "wait"],
	];
	for (const [status, busy, expected] of table) {
		it(`${status} ${busy ? "busy" : "idle"} -> ${expected}`, () => {
			expect(extensionApplyDecision({ status, busy })).toBe(expected);
		});
	}
});
