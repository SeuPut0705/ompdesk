import { afterEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { hydrateDisplayPreferences, readDisplayPreference, setDisplayPreference } from "./display-preferences";

afterEach(() => {
	useUiStore.setState({ displayPreferences: {} });
	useSettingsStore.getState().reset();
	vi.unstubAllGlobals();
});
describe("GUI display preference ownership", () => {
	it("keeps false and zero overrides and ignores a delayed boot snapshot after an edit", async () => {
		const save = vi.fn(async () => {});
		vi.stubGlobal("window", { omp: { prefs: { set: save } } });
		useSettingsStore.setState({ showTokenUsage: true, pasteMenuThreshold: 100 });
		await setDisplayPreference("showTokenUsage", false);
		hydrateDisplayPreferences({ showTokenUsage: true, pasteMenuThreshold: 0, hideThinkingBlock: "true" });
		expect(readDisplayPreference("showTokenUsage")).toBe(false);
		expect(readDisplayPreference("pasteMenuThreshold")).toBe(0);
		expect(useUiStore.getState().displayPreferences.hideThinkingBlock).toBeUndefined();
		expect(useSettingsStore.getState().showTokenUsage).toBe(true);
		expect(save).toHaveBeenCalledWith("displayPreferences.showTokenUsage", false);
		await setDisplayPreference("showTokenUsage", null);
		expect(readDisplayPreference("showTokenUsage")).toBe(true);
	});
	it("leaves the previous visible value on persistence failure", async () => {
		vi.stubGlobal("window", {
			omp: {
				prefs: {
					set: vi.fn(async () => {
						throw new Error("disk full");
					}),
				},
			},
		});
		useUiStore.setState({ displayPreferences: { showTokenUsage: false } });
		expect(await setDisplayPreference("showTokenUsage", true)).toBe(false);
		expect(readDisplayPreference("showTokenUsage")).toBe(false);
	});
});
