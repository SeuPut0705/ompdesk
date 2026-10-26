import { describe, expect, it } from "vitest";
import { type AutoCloseFacts, autoCloseDecision } from "./auto-close";

/** A finished child nobody uses, without a branch: the baseline every case bends one fact of. */
const finished: AutoCloseFacts = {
	openedByAgent: true,
	stored: true,
	idle: true,
	settled: true,
	answered: true,
	ended: "ok",
	result: "ok",
	branch: null,
	looked: false,
	userTouched: false,
	collected: true,
};

const landed = { hasWork: true, landed: true, clean: true };

describe("autoCloseDecision", () => {
	it("closes a finished session without a branch once its answer is in, and leaves its worktree alone", () => {
		expect(autoCloseDecision(finished)).toEqual({ action: "close", removeWorktree: false });
	});

	it("closes a landed, clean branch and removes its worktree; a landed one with files left over stays open", () => {
		expect(autoCloseDecision({ ...finished, branch: landed })).toEqual({ action: "close", removeWorktree: true });
		expect(autoCloseDecision({ ...finished, branch: { ...landed, clean: false } })).toEqual({
			action: "keep",
			reason: "uncommitted",
		});
	});

	it("never closes a landed, clean branch while the session still works", () => {
		expect(autoCloseDecision({ ...finished, idle: false, branch: landed })).toEqual({
			action: "keep",
			reason: "working",
		});
	});

	it("keeps a branch whose commits nothing merged, and one that never committed anything", () => {
		expect(autoCloseDecision({ ...finished, branch: { ...landed, landed: false } })).toEqual({
			action: "keep",
			reason: "unmerged",
		});
		expect(autoCloseDecision({ ...finished, branch: { hasWork: false, landed: true, clean: true } })).toEqual({
			action: "keep",
			reason: "nothing-landed",
		});
	});

	it("never closes a session the person opened, or one that has no file to reopen", () => {
		expect(autoCloseDecision({ ...finished, openedByAgent: false })).toEqual({
			action: "keep",
			reason: "not-agent-opened",
		});
		expect(autoCloseDecision({ ...finished, stored: false })).toEqual({ action: "keep", reason: "not-stored" });
	});

	it("keeps a session that works, waits, runs something in the background or has no answer yet", () => {
		for (const patch of [{ idle: false }, { settled: false }] as const)
			expect(autoCloseDecision({ ...finished, ...patch })).toEqual({ action: "keep", reason: "working" });
		expect(autoCloseDecision({ ...finished, answered: false })).toEqual({ action: "keep", reason: "no-answer" });
	});

	it("keeps a finished session that ended badly, whatever its branch says", () => {
		expect(autoCloseDecision({ ...finished, ended: "failed", branch: landed })).toEqual({
			action: "keep",
			reason: "failed",
		});
	});

	it("closes a Result: problem session's tab once the opener read it, whatever its branch says, and keeps an unlanded worktree", () => {
		expect(autoCloseDecision({ ...finished, result: "problem" })).toEqual({ action: "close", removeWorktree: false });
		for (const branch of [
			{ hasWork: true, landed: false, clean: true },
			{ hasWork: true, landed: true, clean: false },
			{ hasWork: false, landed: false, clean: true },
		])
			expect(autoCloseDecision({ ...finished, result: "problem", branch })).toEqual({
				action: "close",
				removeWorktree: false,
			});
		expect(autoCloseDecision({ ...finished, result: "problem", branch: landed })).toEqual({
			action: "close",
			removeWorktree: true,
		});
	});

	it("keeps a problem session until its opener read the answer, and every guard that holds an ok one", () => {
		const problem = { ...finished, result: "problem" } as const;
		expect(autoCloseDecision({ ...problem, collected: false })).toEqual({ action: "keep", reason: "not-collected" });
		expect(autoCloseDecision({ ...problem, looked: true })).toEqual({ action: "keep", reason: "looked-at" });
		expect(autoCloseDecision({ ...problem, userTouched: true })).toEqual({ action: "keep", reason: "user-touched" });
		expect(autoCloseDecision({ ...problem, ended: "failed" })).toEqual({ action: "keep", reason: "failed" });
		expect(autoCloseDecision({ ...problem, idle: false })).toEqual({ action: "keep", reason: "working" });
		expect(autoCloseDecision({ ...problem, answered: false })).toEqual({ action: "keep", reason: "no-answer" });
	});

	it("leaves a finished session with no verdict line open", () => {
		expect(autoCloseDecision({ ...finished, result: "missing", branch: landed })).toEqual({
			action: "keep",
			reason: "no-result",
		});
	});

	it("never closes a tab the person looks at or touched, even once its work landed", () => {
		expect(autoCloseDecision({ ...finished, branch: landed, looked: true })).toEqual({
			action: "keep",
			reason: "looked-at",
		});
		expect(autoCloseDecision({ ...finished, branch: landed, userTouched: true })).toEqual({
			action: "keep",
			reason: "user-touched",
		});
	});

	it("waits until the opener has read the answer", () => {
		expect(autoCloseDecision({ ...finished, collected: false })).toEqual({
			action: "keep",
			reason: "not-collected",
		});
	});
});
