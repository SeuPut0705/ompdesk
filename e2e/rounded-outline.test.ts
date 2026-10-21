import { describe, expect, it } from "vitest";
import { outsideRoundedOutline } from "./rounded-outline";

const box = { left: 0, top: 0, right: 200, bottom: 40 };

describe("outsideRoundedOutline", () => {
	it("is true for a point in a rounded corner past the curve", () => {
		expect(outsideRoundedOutline(box, [8, 8, 8, 8], 199, 39)).toBe(true);
		expect(outsideRoundedOutline(box, [8, 8, 8, 8], 1, 1)).toBe(true);
	});

	it("is false for a point inside the drawn curve, however near the corner", () => {
		expect(outsideRoundedOutline(box, [8, 8, 8, 8], 195, 35)).toBe(false);
		// A large rounded scroller: a point 3 px from its corner edges is in the corner square yet on the drawn area.
		expect(outsideRoundedOutline(box, [16, 16, 16, 16], 192, 32)).toBe(false);
	});

	it("is false where the corner is square, away from every corner, or outside the box", () => {
		expect(outsideRoundedOutline(box, [8, 0, 8, 8], 199, 1)).toBe(false);
		expect(outsideRoundedOutline(box, [8, 8, 8, 8], 100, 39)).toBe(false);
		expect(outsideRoundedOutline(box, [8, 8, 8, 8], 201, 39)).toBe(false);
	});

	it("caps a radius at half the box, as CSS draws it", () => {
		expect(outsideRoundedOutline(box, [999, 999, 999, 999], 100, 1)).toBe(false);
		expect(outsideRoundedOutline(box, [999, 999, 999, 999], 2, 2)).toBe(true);
	});
});
