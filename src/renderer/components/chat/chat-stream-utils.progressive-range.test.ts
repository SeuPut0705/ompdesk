import { describe, expect, it } from "vitest";
import { progressiveRange } from "./chat-stream-utils";

const key = (index: number) => `row-${index}`;
const range = { startIndex: 10, endIndex: 12, overscan: 3, count: 30 };

describe("progressive overscan", () => {
	it("mounts every on-screen row at once and only a budget of new overscan rows, nearest first", () => {
		const { indexes, deferred } = progressiveRange(range, key, new Set(), 2);
		// Rows 10-12 are on screen; above-then-below at distance one.
		expect(indexes).toEqual([9, 10, 11, 12, 13]);
		expect(deferred).toBe(true);
	});

	it("keeps overscan rows already mounted and fills the rest over later rounds", () => {
		const mounted = new Set([9, 10, 11, 12, 13].map(key));
		const next = progressiveRange(range, key, mounted, 2);
		expect(next.indexes).toEqual([8, 9, 10, 11, 12, 13, 14]);
		const last = progressiveRange(range, key, new Set(next.indexes.map(key)), 2);
		expect(last.indexes).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15]);
		expect(last.deferred).toBe(false);
	});

	it("never holds back an on-screen row, however many are new", () => {
		const wide = { startIndex: 0, endIndex: 14, overscan: 8, count: 15 };
		const { indexes, deferred } = progressiveRange(wide, key, new Set(), 0);
		expect(indexes).toEqual(Array.from({ length: 15 }, (_, index) => index));
		expect(deferred).toBe(false);
	});
});
