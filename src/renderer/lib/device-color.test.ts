import { describe, expect, it } from "vitest";
import { autoDeviceColor, DEVICE_COLORS, deviceColorOf } from "./device-color";

describe("a device header's color", () => {
	it("is a host's own by itself, the same on every launch, and spread across the palette", () => {
		expect(autoDeviceColor("dev-studio")).toBe(autoDeviceColor("dev-studio"));
		const seen = new Set(Array.from({ length: 60 }, (_, n) => autoDeviceColor(`host-${n}`)));
		expect(seen.size).toBe(DEVICE_COLORS.length);
	});

	it("follows the choice, none for this computer unless chosen", () => {
		expect(deviceColorOf("dev", undefined, false)).toBe(autoDeviceColor("dev"));
		expect(deviceColorOf("local", undefined, true)).toBeNull();
		expect(deviceColorOf("dev", "none", false)).toBeNull();
		expect(deviceColorOf("local", "teal", true)).toBe("teal");
	});
});
