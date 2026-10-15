import { describe, expect, it } from "vitest";
import {
	forgetSplitTab,
	readRememberedSplits,
	recallSplit,
	rememberedSplitOf,
	rememberSplit,
	type SplitLayout,
	splitTabIds,
	viewAfterPick,
	withoutSplitTab,
} from "./split-layout";

const pair = (a: string, b: string, ratio = 0.5): SplitLayout => ({
	axis: "columns",
	ratio,
	first: { tabId: a },
	second: { tabId: b },
});
const three: SplitLayout = { axis: "columns", ratio: 0.3, first: { tabId: "a" }, second: pair("b", "c") };

describe("viewAfterPick", () => {
	it("only moves focus when the pick is a pane of the visible split", () => {
		const view = { split: three, remembered: [pair("x", "y")] };
		expect(viewAfterPick(view, "b")).toBe(view);
	});

	it("shows a session outside every split alone and remembers the visible split", () => {
		const view = viewAfterPick({ split: three, remembered: [] }, "z");
		expect(view).toEqual({ split: null, remembered: [three] });
	});

	it("restores a remembered split exactly and remembers the visible one in turn", () => {
		const xy = pair("x", "y", 0.7);
		const view = viewAfterPick({ split: three, remembered: [xy] }, "y");
		expect(view.split).toBe(xy);
		expect(view.remembered).toEqual([three]);
	});

	it("restores a remembered split while a session is shown alone", () => {
		const view = viewAfterPick({ split: null, remembered: [three, pair("x", "y")] }, "c");
		expect(view.split).toBe(three);
		expect(view.remembered).toEqual([pair("x", "y")]);
	});

	it("is a no-op for a solo session in no split", () => {
		expect(viewAfterPick({ split: null, remembered: [] }, "z")).toEqual({ split: null, remembered: [] });
	});
});

describe("remembered split bookkeeping", () => {
	it("drops a session from its split and dissolves a split left with one", () => {
		expect(splitTabIds(forgetSplitTab([three], "b")[0]!)).toEqual(["a", "c"]);
		expect(forgetSplitTab([pair("x", "y")], "x")).toEqual([]);
		expect(forgetSplitTab([three], "unknown")).toEqual([three]);
		expect(withoutSplitTab(three, "a")).toEqual(pair("b", "c"));
	});

	it("keeps a session in at most one split", () => {
		const next = rememberSplit([three, pair("x", "y")], pair("c", "x"));
		expect(next.map(splitTabIds)).toEqual([
			["a", "b"],
			["c", "x"],
		]);
		expect(rememberedSplitOf(next, "y")).toBeUndefined();
	});

	it("recalls the split a session belongs to", () => {
		const xy = pair("x", "y");
		expect(recallSplit([three, xy], "x")).toEqual({ split: xy, rest: [three] });
		expect(recallSplit([three], "q")).toEqual({ split: null, rest: [three] });
	});
});

describe("readRememberedSplits", () => {
	const identity = (id: string) => id;

	it("accepts only an array and skips malformed entries", () => {
		expect(readRememberedSplits("nope", identity, new Set())).toEqual([]);
		expect(readRememberedSplits([null, 3, { axis: "rows" }, pair("a", "b")], identity, new Set())).toEqual([
			pair("a", "b"),
		]);
	});

	it("drops claimed and unknown sessions and dissolves what is left with one", () => {
		const claimed = new Set(["a"]);
		const kept = readRememberedSplits([three, pair("q", "r")], id => (id === "r" ? null : id), claimed);
		expect(kept).toEqual([pair("b", "c")]);
		expect([...claimed].sort()).toEqual(["a", "b", "c"]);
	});

	it("never lets two splits share a session", () => {
		expect(readRememberedSplits([pair("a", "b"), pair("b", "c")], identity, new Set())).toEqual([pair("a", "b")]);
	});

	it("bounds the list", () => {
		const many = Array.from({ length: 40 }, (_, index) => pair(`l${index}`, `r${index}`));
		expect(readRememberedSplits(many, identity, new Set())).toHaveLength(16);
	});
});
