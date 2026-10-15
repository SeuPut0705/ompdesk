import { describe, expect, it } from "vitest";
import { paneInDirection } from "./pane-focus";

// Left column a over b; right column c spanning full height.
const BOXES = [
	{ tabId: "a", left: 0, top: 0, right: 400, bottom: 300 },
	{ tabId: "b", left: 0, top: 301, right: 400, bottom: 600 },
	{ tabId: "c", left: 401, top: 0, right: 800, bottom: 600 },
];

describe("paneInDirection", () => {
	it("finds the adjacent pane on each side and nothing past the edge", () => {
		expect(paneInDirection(BOXES, "a", "down")).toBe("b");
		expect(paneInDirection(BOXES, "b", "up")).toBe("a");
		expect(paneInDirection(BOXES, "b", "right")).toBe("c");
		expect(paneInDirection(BOXES, "a", "up")).toBeNull();
		expect(paneInDirection(BOXES, "c", "right")).toBeNull();
	});

	it("prefers the pane overlapping the focused one most", () => {
		const boxes = [
			...BOXES.slice(0, 2),
			{ tabId: "c", left: 401, top: 0, right: 800, bottom: 200 },
			{ tabId: "d", left: 401, top: 201, right: 800, bottom: 600 },
		];
		expect(paneInDirection(boxes, "a", "right")).toBe("c");
		expect(paneInDirection(boxes, "b", "right")).toBe("d");
	});
});
