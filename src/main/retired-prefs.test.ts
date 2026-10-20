import { describe, expect, it } from "vitest";
import { dropRetiredPrefs, RETIRED_PREFS } from "./retired-prefs";

function memoryStore(initial: Record<string, unknown>) {
	const data = { ...initial };
	return { data, delete: (key: string) => void delete data[key] };
}

describe("dropRetiredPrefs", () => {
	it.each(RETIRED_PREFS.map(entry => entry.key))("drops %s and keeps a live pref", key => {
		const store = memoryStore({ [key]: false, language: "en" });
		dropRetiredPrefs(store);
		expect(store.data).toEqual({ language: "en" });
		dropRetiredPrefs(store);
		expect(store.data).toEqual({ language: "en" });
	});

	it("covers the six retired prefs", () => {
		expect(RETIRED_PREFS.map(entry => entry.key).sort()).toEqual(
			[
				"autopilotNotify",
				"autopilotShip",
				"batchNotifications",
				"modelPool",
				"scheduledRetry",
				"worktreeAutoClean",
			].sort(),
		);
	});
});
