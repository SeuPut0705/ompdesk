import { describe, expect, it } from "vitest";
import type { ToolEntry } from "../../../stores/tools";
import { collapseWaitSteps, selectLiveStep } from "./live-step";

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

describe("collapseWaitSteps", () => {
	it("folds only consecutive identical waits and preserves the first start time", () => {
		const entries = new Map([
			["a", { toolName: "wait", args: { i: "background activity" }, startTime: 10 }],
			["b", { toolName: "wait", args: { i: "background activity" }, startTime: 20 }],
			["c", { toolName: "read", args: { path: "a.ts" }, startTime: 30 }],
			["d", { toolName: "wait", args: { i: "background activity" }, startTime: 40 }],
		]);
		expect(collapseWaitSteps(["a", "b", "c", "d"], entries)).toEqual([
			{ id: "b", ids: ["a", "b"], startedAt: 10 },
			{ id: "c", ids: ["c"], startedAt: 30 },
			{ id: "d", ids: ["d"], startedAt: 40 },
		]);
	});
});
