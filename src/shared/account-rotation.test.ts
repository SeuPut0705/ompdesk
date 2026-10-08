import { describe, expect, it } from "vitest";
import { ACCOUNT_ROTATION_MODES, isAccountRotationMode, parseAccountRotationPref } from "./account-rotation";

describe("parseAccountRotationPref", () => {
	it("keeps a known mode and reads anything else as quota (stock omp)", () => {
		expect(parseAccountRotationPref("even")).toBe("even");
		expect(parseAccountRotationPref("quota")).toBe("quota");
		for (const stored of [undefined, null, "", "Even", "round-robin", 1, { mode: "even" }]) {
			expect(parseAccountRotationPref(stored)).toBe("quota");
		}
	});

	it("accepts exactly the offered modes", () => {
		expect(ACCOUNT_ROTATION_MODES.every(isAccountRotationMode)).toBe(true);
		expect(isAccountRotationMode("balanced")).toBe(false);
	});
});
