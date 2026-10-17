import { describe, expect, it } from "vitest";
import type { PersistedTabLayout } from "../tab-layout";
import { WebTabLayouts } from "./web-tab-layouts";

const layout = (sessionPath: string): PersistedTabLayout => ({
	version: 1,
	activeIndex: 0,
	tabs: [{ cwd: "/work", kind: "agent", sessionPath }],
});

function setup(initial?: unknown) {
	const store = { value: initial, writes: 0 };
	const layouts = new WebTabLayouts(
		{
			get: () => store.value,
			set: value => {
				store.value = value;
				store.writes++;
			},
		},
		value => value as PersistedTabLayout,
	);
	return { store, layouts };
}

describe("WebTabLayouts", () => {
	it("files each device's tabs under its id and restores them for the devices still paired", () => {
		const { store, layouts } = setup();
		layouts.save("phone", layout("/s/a.jsonl"));
		layouts.save("tablet", layout("/s/b.jsonl"));
		expect(store.value).toEqual({ phone: layout("/s/a.jsonl"), tablet: layout("/s/b.jsonl") });

		// A relaunch: the tablet was removed while the app was closed.
		expect(layouts.restorable(new Set(["phone"]))).toEqual([{ deviceId: "phone", layout: layout("/s/a.jsonl") }]);
		expect(store.value).toEqual({ phone: layout("/s/a.jsonl") });
	});

	it("forgets a device with no tab left and a revoked device, and writes only on a change", () => {
		const { store, layouts } = setup({ phone: layout("/s/a.jsonl"), tablet: layout("/s/b.jsonl") });
		layouts.save("phone", layout("/s/a.jsonl"));
		expect(store.writes).toBe(0);
		layouts.save("phone", null);
		layouts.drop("tablet");
		expect(store.value).toEqual({});
		expect(layouts.restorable(new Set(["phone", "tablet"]))).toEqual([]);
	});

	it("reads a damaged pref as nothing saved", () => {
		const { layouts } = setup(["not", "a", "record"]);
		expect(layouts.restorable(new Set(["phone"]))).toEqual([]);
	});
});
