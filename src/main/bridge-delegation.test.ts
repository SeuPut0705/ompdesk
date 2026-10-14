/**
 * gui-bridge delegation strength (resources/gui-bridge/delegation-core.ts):
 * each strength holds its stock `task.*` values as runtime overrides on the
 * tab's Settings, a switch drops the previous strength's overrides first,
 * `default` holds nothing, and the user's own Settings write of one of those
 * settings releases the strength so the write is what takes effect.
 */
import { describe, expect, it } from "vitest";
import { DELEGATION_PRESETS, DELEGATION_SETTING_IDS } from "../../resources/gui-bridge/delegation-contracts";
import {
	applyDelegation,
	asDelegationSetting,
	type DelegationSetting,
	heldDelegation,
	releaseDelegationFor,
} from "../../resources/gui-bridge/delegation-core";

/** A Settings scope with only the runtime-override layer stock's handles write to. */
function fakeSettings() {
	const overrides = new Map<string, unknown>();
	const handles = new Map<string, DelegationSetting>(
		DELEGATION_SETTING_IDS.map(id => [
			id,
			{
				id,
				override: (_scope: object, value: unknown) => overrides.set(id, value),
				clearOverride: () => overrides.delete(id),
			},
		]),
	);
	return { scope: {}, overrides, handle: (id: string) => handles.get(id) };
}

describe("delegation strength", () => {
	it("holds a strength's stock values as runtime overrides", () => {
		const { scope, overrides, handle } = fakeSettings();
		expect(heldDelegation(scope)).toBe("default");
		expect(applyDelegation(handle, scope, "swarm")).toBe("swarm");
		expect(Object.fromEntries(overrides)).toEqual(DELEGATION_PRESETS.swarm);
		expect(heldDelegation(scope)).toBe("swarm");
	});

	it("drops the previous strength's overrides before the next, and default holds nothing", () => {
		const { scope, overrides, handle } = fakeSettings();
		applyDelegation(handle, scope, "solo");
		expect(overrides.get("task.maxRecursionDepth")).toBe(0);
		applyDelegation(handle, scope, "collaborative");
		expect(Object.fromEntries(overrides)).toEqual({ "task.eager": "preferred", "task.maxConcurrency": 8 });
		applyDelegation(handle, scope, "default");
		expect(overrides.size).toBe(0);
		expect(heldDelegation(scope)).toBe("default");
	});

	it("keeps strengths per Settings scope", () => {
		const first = fakeSettings();
		const second = fakeSettings();
		applyDelegation(first.handle, first.scope, "assisted");
		expect(heldDelegation(second.scope)).toBe("default");
	});

	it("releases the strength when the user writes one of its settings, and only then", () => {
		const { scope, overrides, handle } = fakeSettings();
		applyDelegation(handle, scope, "assisted");
		expect(releaseDelegationFor("task.maxRecursionDepth", scope, handle)).toBe(false);
		expect(releaseDelegationFor("compaction.enabled", scope, handle)).toBe(false);
		expect(heldDelegation(scope)).toBe("assisted");
		expect(releaseDelegationFor("task.maxConcurrency", scope, handle)).toBe(true);
		expect(overrides.size).toBe(0);
		expect(heldDelegation(scope)).toBe("default");
	});

	it("refuses an omp that lacks a setting a strength needs, leaving the current strength", () => {
		const { scope, overrides, handle } = fakeSettings();
		applyDelegation(handle, scope, "collaborative");
		const partial = (id: string) => (id === "task.maxRecursionDepth" ? undefined : handle(id));
		expect(() => applyDelegation(partial, scope, "solo")).toThrow("task.maxRecursionDepth");
		expect(heldDelegation(scope)).toBe("collaborative");
		expect(Object.fromEntries(overrides)).toEqual({ "task.eager": "preferred", "task.maxConcurrency": 8 });
	});

	it("accepts only handles with the members it calls", () => {
		expect(asDelegationSetting({ id: "task.eager", override() {}, clearOverride() {} })).toBeDefined();
		expect(asDelegationSetting({ id: "task.eager", override() {} })).toBeUndefined();
		expect(asDelegationSetting(undefined)).toBeUndefined();
	});
});
