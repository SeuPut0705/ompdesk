import { describe, expect, it } from "vitest";
import { orderByManual } from "../../shared/sidebar-rows";
import { reorderProjects } from "./project-order";

const group = (cwd: string, at: number) => ({ cwd, at });
const order = (groups: readonly { cwd: string; at: number }[], pinned: string[], manual: string[]) =>
	orderByManual(groups, g => g.cwd, { pinned, manual, recency: g => g.at }).map(g => g.cwd);

describe("orderByManual", () => {
	it("falls back to newest activity first when nothing was dragged", () => {
		expect(order([group("/a", 1), group("/b", 3), group("/c", 2)], [], [])).toEqual(["/b", "/c", "/a"]);
	});

	it("keeps a dragged order regardless of activity, with unplaced projects on top", () => {
		expect(order([group("/a", 9), group("/b", 1), group("/c", 5), group("/new", 0)], [], ["/b", "/c", "/a"])).toEqual(
			["/new", "/b", "/c", "/a"],
		);
	});

	it("keeps pinned projects above everything, ordered the same way inside", () => {
		expect(
			order(
				[group("/a", 1), group("/b", 2), group("/p1", 0), group("/p2", 0)],
				["/p1", "/p2"],
				["/p2", "/p1", "/a", "/b"],
			),
		).toEqual(["/p2", "/p1", "/a", "/b"]);
	});
});

describe("reorderProjects", () => {
	it("moves the dragged project to the drop target's slot, both directions", () => {
		expect(reorderProjects(["/a", "/b", "/c", "/d"], "/a", "/c")).toEqual(["/b", "/c", "/a", "/d"]);
		expect(reorderProjects(["/a", "/b", "/c", "/d"], "/d", "/b")).toEqual(["/a", "/d", "/b", "/c"]);
	});

	it("leaves the order alone for a no-op or unknown drop", () => {
		expect(reorderProjects(["/a", "/b"], "/a", "/a")).toEqual(["/a", "/b"]);
		expect(reorderProjects(["/a", "/b"], "/x", "/a")).toEqual(["/a", "/b"]);
	});
});
