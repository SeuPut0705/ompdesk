import { describe, expect, it } from "vitest";
import {
	DEVICE_LOCAL_PREF_KEYS,
	isDeviceLocalPref,
	nestDevicePrefs,
	overlayDevicePrefs,
	readDevicePref,
} from "./device-prefs";

describe("device-local preferences", () => {
	it("keeps appearance and layout on the device and everything else on the host", () => {
		for (const key of [
			"themeName",
			"theme",
			"systemLightTheme",
			"systemDarkTheme",
			"fontSize",
			"compactDensity",
			"colorBlindMode",
			"followAgentTheme",
			"transcriptDetail",
			"thinkingExpanded",
			"workBoard",
			"codeLineNumbers",
			"sidebarWidth",
			"sidebarVisible",
			"sidebarFolds",
			"sidebarFamilies",
			"gui.panelWidth",
			"panelSide",
			"defaultPanelTab",
			"displayPreferences",
			"displayPreferences.hideThinkingBlock",
		]) {
			expect(isDeviceLocalPref(key), key).toBe(true);
		}
		for (const key of [
			"language",
			"replyLanguage",
			"notifications",
			"notificationSound",
			"notificationVolume",
			"linkPreview",
			"keymapOverrides",
			"sidebar",
			"userProfile",
			"autoTitle",
			"gui",
			"displayPreferencesX",
		]) {
			expect(isDeviceLocalPref(key), key).toBe(false);
		}
		expect(new Set(DEVICE_LOCAL_PREF_KEYS).size).toBe(DEVICE_LOCAL_PREF_KEYS.length);
	});

	it("overlays the device's values on the host's and hides the host's own appearance", () => {
		const host = {
			language: "ko",
			themeName: "light",
			fontSize: 18,
			gui: { panelWidth: 700, other: 1 },
			displayPreferences: { hideThinkingBlock: true },
		};
		const merged = overlayDevicePrefs(host, {
			themeName: "dark",
			"gui.panelWidth": 320,
			"displayPreferences.showTokenUsage": true,
		});
		expect(merged).toEqual({
			language: "ko",
			themeName: "dark",
			gui: { panelWidth: 320, other: 1 },
			displayPreferences: { showTokenUsage: true },
		});
		// The host's object is not touched.
		expect(host.gui).toEqual({ panelWidth: 700, other: 1 });
	});

	it("shows a device with nothing set none of the host's appearance", () => {
		expect(overlayDevicePrefs({ themeName: "light", fontSize: 18, language: "en" }, {})).toEqual({ language: "en" });
		expect(overlayDevicePrefs(undefined, {})).toEqual({});
	});

	it("ignores a stored key that is not device-local", () => {
		expect(overlayDevicePrefs({ language: "en" }, { language: "ko" })).toEqual({ language: "en" });
		expect(nestDevicePrefs({ language: "ko", fontSize: 14 })).toEqual({ fontSize: 14 });
	});

	it("reads one key, and the displayPreferences container, from the record", () => {
		const device = { "displayPreferences.showTokenUsage": true, "gui.panelWidth": 300 };
		expect(readDevicePref(device, "gui.panelWidth")).toBe(300);
		expect(readDevicePref(device, "displayPreferences")).toEqual({ showTokenUsage: true });
		expect(readDevicePref(device, "themeName")).toBeUndefined();
	});
});
