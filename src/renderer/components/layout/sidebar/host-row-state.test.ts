import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../../../../shared/session-summary";
import { hostSectionSummary, summaryRowState } from "./host-row-state";

function summary(path: string, change: Partial<SessionSummary> = {}): SessionSummary {
	return { sessionPath: path, tabId: path, cwd: "C:\\work", kind: "agent", status: "ready", agents: [], ...change };
}

describe("summaryRowState", () => {
	it("reads the running computer's turn as running, its background work as running and settling", () => {
		expect(summaryRowState(summary("a", { status: "running" }))).toMatchObject({
			running: true,
			settling: false,
			fold: "running",
		});
		expect(summaryRowState(summary("a", { status: "running", settling: true }))).toMatchObject({
			running: true,
			settling: true,
		});
	});

	it("reads a compaction between turns as work under way, as a turn is", () => {
		expect(summaryRowState(summary("a", { status: "ready", compacting: true }))).toMatchObject({
			running: true,
			settling: false,
			fold: "running",
		});
	});

	it("puts the session's own prompt before its run: a question or an approval, as the summary says", () => {
		expect(summaryRowState(summary("a", { status: "running", ask: "input" }))).toMatchObject({
			waiting: true,
			ask: "question",
			running: false,
			fold: "question",
		});
		expect(summaryRowState(summary("a", { ask: "approval" })).fold).toBe("approval");
	});

	it("says nothing a session that is down needs from the person", () => {
		expect(summaryRowState(summary("a", { status: "restarting", ask: "input" }))).toMatchObject({
			down: true,
			waiting: false,
			running: false,
		});
	});

	it("names why the running computer says its omp failed, never for a wait on the session", () => {
		const failure = { message: "omp 18.0 is too old" };
		expect(summaryRowState(summary("a", { status: "error", failure })).reason).toBe("omp 18.0 is too old");
		expect(summaryRowState(summary("a", { status: "error", sessionHeld: true, failure })).reason).toBeUndefined();
		expect(summaryRowState(summary("a", { status: "ready" })).reason).toBeUndefined();
	});

	it("shows an unseen finish only from this view's own mark, and nothing for a session no computer runs", () => {
		expect(summaryRowState(summary("a"), true)).toMatchObject({ done: true, fold: "done" });
		expect(summaryRowState(summary("a")).fold).toBeNull();
		expect(summaryRowState(undefined)).toMatchObject({ running: false, waiting: false, fold: null });
	});
});

describe("hostSectionSummary", () => {
	it("counts what the host's summaries say its sessions do, whatever tab this computer holds", () => {
		const folded = hostSectionSummary([
			summary("a", { status: "running" }),
			summary("b", { ask: "approval" }),
			summary("c"),
		]);
		expect(folded).toMatchObject({ running: 1, waiting: 1 });
	});
});
