import { describe, expect, it } from "vitest";
import {
	buildSessionTreeLayout,
	SESSION_ROOT_ID,
	type SessionTreeEntry,
	type SessionTreeLayout,
} from "./session-tree-layout";

function entry(entryId: string, parentId: string | null): SessionTreeEntry {
	return {
		entryId,
		parentId,
		role: "user",
		textPreview: entryId,
		timestamp: 0,
		onActiveBranch: true,
		isLeaf: false,
	};
}

/** One unbranched conversation `count` entries long: every entry is its predecessor's only child. */
function chain(count: number): SessionTreeEntry[] {
	return Array.from({ length: count }, (_, index) => entry(`e${index}`, index === 0 ? null : `e${index - 1}`));
}

const nodeOf = (layout: SessionTreeLayout, id: string) => layout.nodes.find(node => node.id === id);

describe("buildSessionTreeLayout", () => {
	// v0.36.1 on a phone: "Maximum call stack size exceeded" at `place` (react-render), from a long session's tree.
	// The slot pass recursed once per level, so an unbranched chain thousands of entries deep overflowed the stack
	// (a phone's WebKit early, V8 at ~5,000 in a plain script); the depth pass walked up from every entry, quadratic
	// (38 s for a 20,000-entry chain).
	it("lays out a chain far deeper than the call stack, in linear time", () => {
		const started = performance.now();
		const layout = buildSessionTreeLayout(chain(100_000));
		expect(layout.nodeCount).toBe(100_000);
		expect(nodeOf(layout, "e99999")?.depth).toBe(100_000);
		// One column: every node of a chain sits in slot 0.
		expect(new Set(layout.nodes.map(node => node.x)).size).toBe(1);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("centres parents on their children and keeps siblings in wire order", () => {
		const layout = buildSessionTreeLayout([entry("a", null), entry("b", "a"), entry("c", "a"), entry("d", "c")]);
		const x = (id: string) => nodeOf(layout, id)?.x ?? Number.NaN;
		expect(x("b")).toBeLessThan(x("c"));
		expect(x("c")).toBe(x("d"));
		expect(x("a")).toBe((x("b") + x("c")) / 2);
		expect(x(SESSION_ROOT_ID)).toBe(x("a"));
		expect(nodeOf(layout, "d")?.depth).toBe(3);
		expect(layout.forkCount).toBe(1);
	});

	it("re-attaches a parent cycle to the session root", () => {
		const layout = buildSessionTreeLayout([entry("a", "b"), entry("b", "a"), entry("c", "b")]);
		expect(layout.nodes).toHaveLength(4);
		for (const node of layout.nodes) expect(Number.isFinite(node.x)).toBe(true);
		const roots = layout.edges.filter(edge => edge.parentId === SESSION_ROOT_ID);
		expect(roots.length).toBeGreaterThan(0);
	});
});
