import { describe, expect, it } from "vitest";
import { orderProjects, reorderProjects } from "./project-order";

const group = (cwd: string, at: number) => ({ cwd, at });
const recency = (g: { at: number }) => g.at;

describe("orderProjects", () => {
	it("falls back to newest activity first when nothing was dragged", () => {
		const out = orderProjects([group("/a", 1), group("/b", 3), group("/c", 2)], { pinned: [], manual: [], recency });
		expect(out.map(g => g.cwd)).toEqual(["/b", "/c", "/a"]);
	});

	it("keeps a dragged order regardless of activity, with unplaced projects on top", () => {
		const out = orderProjects([group("/a", 9), group("/b", 1), group("/c", 5), group("/new", 0)], {
			pinned: [],
			manual: ["/b", "/c", "/a"],
			recency,
		});
		expect(out.map(g => g.cwd)).toEqual(["/new", "/b", "/c", "/a"]);
	});

	it("keeps pinned projects above everything, ordered the same way inside", () => {
		const out = orderProjects([group("/a", 1), group("/b", 2), group("/p1", 0), group("/p2", 0)], {
			pinned: ["/p1", "/p2"],
			manual: ["/p2", "/p1", "/a", "/b"],
			recency,
		});
		expect(out.map(g => g.cwd)).toEqual(["/p2", "/p1", "/a", "/b"]);
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
