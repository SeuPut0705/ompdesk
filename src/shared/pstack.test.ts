import { describe, expect, it } from "vitest";
import { PSTACK_PREF, pstackEnabled } from "./pstack";

describe("pstackEnabled", () => {
	it("is off only for an explicit false", () => {
		expect(PSTACK_PREF).toBe("pstack");
		expect(pstackEnabled(undefined)).toBe(true);
		expect(pstackEnabled(null)).toBe(true);
		expect(pstackEnabled(true)).toBe(true);
		expect(pstackEnabled("false")).toBe(true);
		expect(pstackEnabled(false)).toBe(false);
	});
});
