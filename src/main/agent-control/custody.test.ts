import { describe, expect, it } from "vitest";
import type { BranchFacts } from "./branches";
import { custodyOf } from "./custody";

const facts: BranchFacts = {
	branch: "omp/agent/a",
	baseBranch: "main",
	commitsAhead: 1,
	files: [{ path: "src/a.ts", added: 1, removed: 0 }],
	filesTruncated: false,
	uncommitted: 0,
	untracked: 0,
	baseUncommitted: 0,
	merged: false,
};

describe("custodyOf", () => {
	it("agrees with a report whose files are all in its committed change", () => {
		expect(custodyOf(facts, ["/wt/omp/agent/a/src/a.ts"])).toEqual({
			line: "Git (omp/agent/a): 1 commit(s) not in main yet.",
			gap: null,
		});
	});

	it("never calls a file missing when untracked files or a cut list could hold it", () => {
		expect(custodyOf({ ...facts, untracked: 1 }, ["src/new.ts"]).line).not.toContain("reported but unchanged");
		expect(custodyOf({ ...facts, filesTruncated: true }, ["src/new.ts"]).gap).toBeNull();
	});

	it("never calls a file missing from a landed branch, whose change is measured from its tip", () => {
		expect(custodyOf({ ...facts, merged: true, commitsAhead: 0, files: [] }, ["src/a.ts"])).toEqual({
			line: "Git (omp/agent/a): landed.",
			gap: null,
		});
	});

	it("names a detached base generically", () => {
		expect(custodyOf({ ...facts, baseBranch: null }).line).toContain("not in the base yet");
	});
});
