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

	it("closes a merged branch and removes its worktree only when that is clean", () => {
		expect(autoCloseDecision({ ...finished, branch: landed })).toEqual({ action: "close", removeWorktree: true });
		expect(autoCloseDecision({ ...finished, branch: { ...landed, clean: false } })).toEqual({
			action: "close",
			removeWorktree: false,
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
