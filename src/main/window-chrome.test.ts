import { describe, expect, it } from "vitest";
import { sanitizeChromeColors, TOP_BAR_HEIGHT, windowChromeOptions } from "./window-chrome";

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

	it("leaves other platforms on the native frame", () => {
		expect(windowChromeOptions("linux", false)).toEqual({});
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
