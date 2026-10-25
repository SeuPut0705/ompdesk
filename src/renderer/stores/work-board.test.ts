import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateCollapsed, useWorkBoardStore } from "./work-board";

describe("migrateCollapsed", () => {
	it("keeps today's section ids", () => {
		expect(migrateCollapsed({ needs: true, now: true, plan: true, current: true, autopilot: true })).toEqual({
			needs: true,
			now: true,
			plan: true,
			current: true,
			autopilot: true,
		});
	});

	it("drops the retired sections' folds instead of folding the zone that took their rows", () => {
		expect(
			migrateCollapsed({
				waiting: true,
				check: true,
				turn: true,
				running: true,
				opened: true,
				todos: true,
				goal: true,
			}),
		).toEqual({});
		// A fold of today's section beside a retired one survives alone.
		expect(migrateCollapsed({ check: true, current: true })).toEqual({ current: true });
	});

	it("drops ids nothing lists, values that are not a fold and a pref that is not an object", () => {
		expect(migrateCollapsed({ backlog: true, running: false, current: "yes", plan: true })).toEqual({ plan: true });
		expect(migrateCollapsed(null)).toEqual({});
		expect(migrateCollapsed("waiting")).toEqual({});
		expect(migrateCollapsed(undefined)).toEqual({});
	});
});

describe("useWorkBoardStore.hydrate", () => {
	afterEach(() => {
		useWorkBoardStore.getState().reset();
		Reflect.deleteProperty(globalThis, "window");
	});

	it("keeps today's folds of a saved pref and drops the old sections' ones, beside a fold made before the read", async () => {
		const set = vi.fn(async () => {});
		Reflect.set(globalThis, "window", {
			omp: { prefs: { get: vi.fn(async () => ({ running: true, todos: true, plan: true })), set } },
		});
		// The person folded Current work before the pref landed.
		useWorkBoardStore.setState({ hydrated: false, collapsed: { current: true } });
		await useWorkBoardStore.getState().hydrate();
		expect(useWorkBoardStore.getState().collapsed).toEqual({ plan: true, current: true });
	});
});
