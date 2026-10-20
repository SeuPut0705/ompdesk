import { describe, expect, it } from "vitest";
import { contentAnchor } from "./content-anchor";

/** Rows of `heights` laid out from 0, keyed `r<index>`. */
function rows(heights: number[]) {
	let start = 0;
	return heights.map((height, index) => {
		const item = { key: `r${index}`, index, start, end: start + height };
		start += height;
		return item;
	});
}

describe("contentAnchor", () => {
	// Viewport 100..300 over rows 0-49, 50-149, 150-199, 200-279, 280-379.
	const items = rows([50, 100, 50, 80, 100]);

	it("holds the topmost row fully in view that the commit left alone", () => {
		// r1 straddles the top; r2 is the first row fully in view, r3 below it changed.
		expect(contentAnchor(items, 100, 200, index => index === 3)).toEqual({ key: "r2", index: 2, offset: 50 });
		// A changed first row in view grows upward over the row below it, which is held.
		expect(contentAnchor(items, 100, 200, index => index === 2)).toEqual({ key: "r3", index: 3, offset: 100 });
	});

	it("holds nothing when no row in view changed, or no unchanged row is fully in view", () => {
		expect(contentAnchor(items, 100, 200, index => index === 0)).toBeNull();
		expect(contentAnchor(items, 100, 200, index => index !== 1)).toBeNull();
	});
});
