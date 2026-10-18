import { describe, expect, it } from "vitest";
import {
	micaSupported,
	nativeThemeSource,
	sanitizeChromeColors,
	TOP_BAR_HEIGHT,
	windowChromeOptions,
} from "./window-chrome";

describe("windowChromeOptions", () => {
	it("insets the macOS traffic lights into the top bar", () => {
		expect(windowChromeOptions("darwin", false)).toEqual({
			titleBarStyle: "hiddenInset",
			trafficLightPosition: { x: 18, y: 17 },
		});
	});

	it("keeps native Windows caption buttons as a themed overlay", () => {
		expect(windowChromeOptions("win32", true)).toEqual({
			titleBarStyle: "hidden",
			titleBarOverlay: { color: "#19191c", symbolColor: "#ededf0", height: TOP_BAR_HEIGHT },
		});
		expect(windowChromeOptions("win32", false).titleBarOverlay).toMatchObject({ color: "#ffffff" });
	});

	it("adds the Mica backdrop on Windows 11 builds only", () => {
		expect(windowChromeOptions("win32", true, true).backgroundMaterial).toBe("mica");
		expect(windowChromeOptions("win32", true).backgroundMaterial).toBeUndefined();
		expect(micaSupported("win32", "10.0.22631")).toBe(true);
		expect(micaSupported("win32", "10.0.22621")).toBe(true);
		expect(micaSupported("win32", "10.0.19045")).toBe(false);
		expect(micaSupported("darwin", "24.0.0")).toBe(false);
	});

	it("leaves other platforms on the native frame", () => {
		expect(windowChromeOptions("linux", false)).toEqual({});
	});
});

describe("nativeThemeSource", () => {
	it("follows the saved scheme, not the OS", () => {
		expect(nativeThemeSource("dark", undefined)).toBe("dark");
		expect(nativeThemeSource("light", "dark")).toBe("light");
		expect(nativeThemeSource("system", "light")).toBe("system");
	});

	it("takes a named theme's scheme from the theme itself, and from the legacy pref beside it", () => {
		expect(nativeThemeSource("nord", "dark")).toBe("dark");
		expect(nativeThemeSource("sepia", "light")).toBe("light");
		expect(nativeThemeSource("hc-light", undefined)).toBe("light");
		expect(nativeThemeSource("tokyo-night", undefined)).toBe("dark");
		expect(nativeThemeSource(undefined, "dark")).toBe("dark");
	});

	it("reads a retired theme id as its successor's scheme", () => {
		expect(nativeThemeSource("paper", undefined)).toBe("light");
		expect(nativeThemeSource("gruvbox", undefined)).toBe("dark");
		expect(nativeThemeSource("matcha", "dark")).toBe("light");
	});

	it("follows the OS when nothing usable is saved", () => {
		expect(nativeThemeSource(undefined, undefined)).toBe("system");
		expect(nativeThemeSource(3, "Graphite")).toBe("system");
		expect(nativeThemeSource("Porcelain", undefined)).toBe("system");
	});
});

describe("sanitizeChromeColors", () => {
	it("accepts hex and rgb colors", () => {
		expect(sanitizeChromeColors({ color: " #f7f7f8 ", symbolColor: "rgb(27, 27, 31)" })).toEqual({
			color: "#f7f7f8",
			symbolColor: "rgb(27, 27, 31)",
		});
	});

	it("rejects anything else", () => {
		expect(sanitizeChromeColors(null)).toBeNull();
		expect(sanitizeChromeColors({ color: "red", symbolColor: "#fff" })).toBeNull();
		expect(sanitizeChromeColors({ color: "#fff", symbolColor: "url(x)" })).toBeNull();
		expect(sanitizeChromeColors({ color: "#fff" })).toBeNull();
	});
});
