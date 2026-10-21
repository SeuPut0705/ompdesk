import { describe, expect, it } from "vitest";
import { LISTBOX_PAGE, listboxTarget } from "./listbox-nav";

describe("listboxTarget", () => {
	it("wraps ↑/↓ at the ends by default, as the composer's menus do", () => {
		expect(listboxTarget("ArrowDown", 2, 3)).toBe(0);
		expect(listboxTarget("ArrowUp", 0, 3)).toBe(2);
	});

	it("stops ↑/↓ at the ends for a search picker", () => {
		expect(listboxTarget("ArrowDown", 2, 3, { wrap: false })).toBe(2);
		expect(listboxTarget("ArrowUp", 0, 3, { wrap: false })).toBe(0);
		expect(listboxTarget("ArrowDown", 0, 3, { wrap: false })).toBe(1);
	});

	it("jumps to the ends and moves a page, either way", () => {
		for (const wrap of [true, false]) {
			expect(listboxTarget("Home", 7, 20, { wrap })).toBe(0);
			expect(listboxTarget("End", 7, 20, { wrap })).toBe(19);
			expect(listboxTarget("PageDown", 18, 20, { wrap })).toBe(19);
			expect(listboxTarget("PageUp", 7, 20, { wrap })).toBe(7 - LISTBOX_PAGE);
		}
	});

	it("moves nothing in an empty list and leaves other keys to the field", () => {
		expect(listboxTarget("ArrowDown", 0, 0, { wrap: false })).toBeNull();
		expect(listboxTarget("Enter", 0, 3)).toBeNull();
		expect(listboxTarget("a", 0, 3)).toBeNull();
	});
});
