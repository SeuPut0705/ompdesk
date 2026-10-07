import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../../stores/tools";
import { selectLiveStep, tailLines } from "./live-step";

type Entry = Pick<ToolEntry, "status" | "startTime">;
const tools = (entries: Record<string, Entry>) => new Map(Object.entries(entries));

describe("selectLiveStep", () => {
	it("picks the most recently started running call", () => {
		const map = tools({
			a: { status: "running", startTime: 10 },
			b: { status: "running", startTime: 30 },
			c: { status: "done", startTime: 40 },
		});
		expect(selectLiveStep(["a", "b", "c"], map, false)).toEqual({ kind: "tool", id: "b" });
	});

	it("treats a call whose arguments still stream as the live step", () => {
		const map = tools({ a: { status: "done", startTime: 10 }, b: { status: "pending", startTime: 20 } });
		expect(selectLiveStep(["a", "b"], map, true)).toEqual({ kind: "tool", id: "b" });
	});

	it("breaks start-time ties toward the later call in the group", () => {
		const map = tools({ a: { status: "running", startTime: 5 }, b: { status: "running", startTime: 5 } });
		expect(selectLiveStep(["a", "b"], map, false)).toEqual({ kind: "tool", id: "b" });
	});

	it("shows live reasoning when no call is running", () => {
		const map = tools({ a: { status: "done", startTime: 10 } });
		expect(selectLiveStep(["a"], map, true)).toEqual({ kind: "thinking" });
	});

	it("keeps the step that just finished until the next one starts", () => {
		const map = tools({ a: { status: "done", startTime: 10 }, b: { status: "error", startTime: 20 } });
		expect(selectLiveStep(["a", "b"], map, false)).toEqual({ kind: "tool", id: "b" });
	});

	it("skips ids the store has not seen and returns null when there is nothing to show", () => {
		const map = tools({ a: { status: "done", startTime: 10 } });
		expect(selectLiveStep(["a", "missing"], map, false)).toEqual({ kind: "tool", id: "a" });
		expect(selectLiveStep(["missing"], map, false)).toBeNull();
		expect(selectLiveStep([], map, false)).toBeNull();
	});
});

describe("tailLines", () => {
	it("returns the last non-blank lines in order", () => {
		expect(tailLines("one\ntwo\n\nthree\n\n", 2)).toEqual(["two", "three"]);
	});

	it("handles short and empty output", () => {
		expect(tailLines("only", 2)).toEqual(["only"]);
		expect(tailLines("", 2)).toEqual([]);
		expect(tailLines("\n\n  \n", 2)).toEqual([]);
	});
});
