import { describe, expect, it } from "vitest";
import { type LaunchProfilePrefs, readLaunchProfile, updateLaunchProfile } from "./launch-profile-store";

/** An in-memory prefs slice, written whole on every set as electron-store does. */
function memoryPrefs(): LaunchProfilePrefs & { stored: () => Record<string, unknown> } {
	let profiles: unknown;
	return {
		get: () => profiles,
		set: (_key, value) => {
			profiles = JSON.parse(JSON.stringify(value));
		},
		stored: () => (profiles ?? {}) as Record<string, unknown>,
	};
}

describe("launch profile store", () => {
	it("merges updates to different fields and workspaces without losing any, and drops an emptied profile", async () => {
		const prefs = memoryPrefs();
		await Promise.all([
			Promise.resolve().then(() => updateLaunchProfile(prefs, "/work/app", { noRules: true })),
			Promise.resolve().then(() => updateLaunchProfile(prefs, "/work/app", { noLsp: true })),
			Promise.resolve().then(() => updateLaunchProfile(prefs, "/work/other", { profile: " isolated " })),
		]);
		expect(prefs.stored()).toEqual({
			"/work/app": { noRules: true, noLsp: true },
			"/work/other": { profile: "isolated" },
		});
		expect(readLaunchProfile(prefs, "/work/app")).toEqual({ noRules: true, noLsp: true });

		updateLaunchProfile(prefs, "/work/app", { noRules: false, noLsp: false });
		expect(prefs.stored()).toEqual({ "/work/other": { profile: "isolated" } });
	});

	it("refuses a relative workspace and a patch that is not an object", () => {
		const prefs = memoryPrefs();
		expect(() => updateLaunchProfile(prefs, "work/app", { noRules: true })).toThrow(/Invalid launch profile/);
		expect(() => updateLaunchProfile(prefs, "/work/app", ["noRules"])).toThrow(/Invalid launch profile/);
		expect(() => readLaunchProfile(prefs, "relative")).toThrow(/Invalid workspace/);
		expect(prefs.stored()).toEqual({});
	});
});
