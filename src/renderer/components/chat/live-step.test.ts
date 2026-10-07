import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../../stores/tools";
import { appendLiveLog, type LiveLog, type LiveLogLine, selectLiveStep, tailLines } from "./live-step";

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

describe("appendLiveLog", () => {
	const out = (...texts: string[]): LiveLogLine[] => texts.map(text => ({ kind: "output", text }));
	const flat = (log: LiveLog) => log.flatMap(segment => segment.lines.map(line => line.text));

	it("appends new steps in order", () => {
		let log: LiveLog = [];
		log = appendLiveLog(log, { key: "tool:a", lines: [{ kind: "tool", text: "a" }] }, 50);
		log = appendLiveLog(log, { key: "tool:b", lines: [{ kind: "tool", text: "b" }, ...out("one")] }, 50);
		expect(log.map(segment => segment.key)).toEqual(["tool:a", "tool:b"]);
		expect(flat(log)).toEqual(["a", "b", "one"]);
	});

	it("returns the same log when a step re-renders with identical lines", () => {
		const log = appendLiveLog([], { key: "tool:a", lines: [{ kind: "tool", text: "a" }, ...out("x")] }, 50);
		expect(appendLiveLog(log, { key: "tool:a", lines: [{ kind: "tool", text: "a" }, ...out("x")] }, 50)).toBe(log);
	});

	it("replaces a step's lines as its output grows instead of repeating them", () => {
		let log = appendLiveLog([], { key: "tool:a", lines: out("one") }, 50);
		log = appendLiveLog(log, { key: "tool:a", lines: out("one", "two") }, 50);
		expect(flat(log)).toEqual(["one", "two"]);
	});

	it("moves a step that becomes current again to the bottom", () => {
		let log = appendLiveLog([], { key: "tool:a", lines: out("a1") }, 50);
		log = appendLiveLog(log, { key: "tool:b", lines: out("b1") }, 50);
		log = appendLiveLog(log, { key: "tool:a", lines: out("a1", "a2") }, 50);
		expect(flat(log)).toEqual(["b1", "a1", "a2"]);
	});

	it("keeps at most `max` lines, dropping the oldest", () => {
		let log = appendLiveLog([], { key: "tool:a", lines: out("a1", "a2") }, 3);
		log = appendLiveLog(log, { key: "tool:b", lines: out("b1", "b2") }, 3);
		expect(flat(log)).toEqual(["a2", "b1", "b2"]);
		log = appendLiveLog(log, { key: "tool:c", lines: out("c1", "c2", "c3", "c4") }, 3);
		expect(log.map(segment => segment.key)).toEqual(["tool:c"]);
		expect(flat(log)).toEqual(["c2", "c3", "c4"]);
		expect(appendLiveLog(log, { key: "tool:c", lines: out("c1", "c2", "c3", "c4") }, 3)).toBe(log);
	});
});
