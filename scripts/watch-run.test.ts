import { describe, expect, it } from "vitest";
import { changedLines, errorLines, jobState, type WatchedJob } from "./watch-run";

const job = (name: string, status: string, conclusion = ""): WatchedJob => ({
	databaseId: 1,
	name,
	status,
	conclusion,
	steps: [],
});

describe("watch-run: one line per job state change", () => {
	it("names a finished job by its conclusion and a running one by its status", () => {
		expect(jobState(job("a", "completed", "failure"))).toBe("failure");
		expect(jobState(job("a", "in_progress"))).toBe("in_progress");
		// completed with no conclusion yet is not a state of its own
		expect(jobState(job("a", "completed"))).toBe("completed");
	});

	it("prints every job the first time, then only the ones that moved", () => {
		const jobs = [job("static", "queued"), job("win-platform (1/2)", "queued")];
		expect(changedLines(new Map(), jobs)).toEqual(["static: queued", "win-platform (1/2): queued"]);

		const seen = new Map([
			["static", "queued"],
			["win-platform (1/2)", "queued"],
		]);
		const next = [job("static", "in_progress"), job("win-platform (1/2)", "queued")];
		expect(changedLines(seen, next)).toEqual(["static: in_progress"]);
		expect(changedLines(new Map(next.map(j => [j.name, jobState(j)])), next)).toEqual([]);
	});
});

describe("watch-run: the first error lines of a job log", () => {
	it("keeps biome's file:line:col diagnostics and drops timestamps and colour", () => {
		const log = [
			"2026-11-04T14:19:35.7992037Z \u001b[36;1mbunx biome check src\u001b[0m",
			"2026-11-04T14:19:41.6559978Z e2e/composer-keys.e2e.ts:260:36 lint/style/useTemplate  FIXABLE  ━━━",
			"2026-11-04T14:19:41.6560499Z ",
			"2026-11-04T14:19:41.6560655Z   i Template literals are preferred over string concatenation.",
			"2026-11-04T14:19:42.0000000Z ##[error]Process completed with exit code 1.",
		].join("\n");
		expect(errorLines(log)).toEqual([
			"e2e/composer-keys.e2e.ts:260:36 lint/style/useTemplate  FIXABLE  ━━━",
			"##[error]Process completed with exit code 1.",
		]);
	});

	it("caps the lines, and falls back to the log's tail when nothing looks like an error", () => {
		const many = Array.from({ length: 40 }, (_, i) => `FAIL test ${i}`).join("\n");
		expect(errorLines(many, 15)).toHaveLength(15);
		expect(errorLines("one\ntwo\nthree", 2)).toEqual(["two", "three"]);
	});
});
