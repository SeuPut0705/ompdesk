import { describe, expect, it } from "vitest";
import { closeToTrayEnabled } from "./desktop-prefs";

describe("closeToTrayEnabled", () => {
	it("reads the close-to-tray pref as on unless explicitly false", () => {
		expect(closeToTrayEnabled(undefined)).toBe(true);
		expect(closeToTrayEnabled(true)).toBe(true);
		expect(closeToTrayEnabled(false)).toBe(false);
	});
});
