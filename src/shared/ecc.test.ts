import { describe, expect, it } from "vitest";
import { ECC_PREF, eccEnabled } from "./ecc";

describe("eccEnabled", () => {
	it("is off only for an explicit false", () => {
		expect(ECC_PREF).toBe("ecc");
		expect(eccEnabled(undefined)).toBe(true);
		expect(eccEnabled(null)).toBe(true);
		expect(eccEnabled(true)).toBe(true);
		expect(eccEnabled("false")).toBe(true);
		expect(eccEnabled(false)).toBe(false);
	});
});
