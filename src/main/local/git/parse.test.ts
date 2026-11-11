import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractDraftJson,
	guiWorktreeCandidate,
	isInside,
	isSafeRelativePath,
	parseGitStatus,
	parsePrUnifiedDiff,
	renderPrompt,
	rollupChecks,
	rollupCounts,
	worktreeSlug,
} from "./parse";

// parseStatusV2 and newFileDiff moved to the core process with their cases (native/ompdesk/crates/core/src/git/parse.rs).

describe("parseGitStatus", () => {
	it("keeps spaces in paths and pairs renames with their origin", () => {
		const text = " M a file.ts\0R  new.ts\0old.ts\0?? dir/x y\0";
		expect(parseGitStatus(text)).toEqual([
			{ path: "a file.ts", oldPath: undefined, index: " ", worktree: "M" },
			{ path: "new.ts", oldPath: "old.ts", index: "R", worktree: " " },
			{ path: "dir/x y", oldPath: undefined, index: "?", worktree: "?" },
		]);
	});
});

describe("path guards", () => {
	it("rejects absolute, NUL and traversal paths", () => {
		for (const bad of ["", "/etc/passwd", "C:\\x", "a/../b", "..\\x", "a\0b"])
			expect(isSafeRelativePath(bad)).toBe(false);
		expect(isSafeRelativePath("src/a..b.ts")).toBe(true);
	});
	it("isInside is strict", () => {
		expect(isInside("/r", "/r/a")).toBe(true);
		expect(isInside("/r", "/r")).toBe(false);
		expect(isInside("/r", "/rx/a")).toBe(false);
	});
});

describe("worktree naming", () => {
	it("slugifies and rejects disallowed characters", () => {
		expect(worktreeSlug("  My Feature  ")).toBe("my-feature");
		expect(worktreeSlug("fix_bug")).toBeNull();
		expect(worktreeSlug("---")).toBeNull();
		expect(worktreeSlug("a".repeat(42))).toBeNull();
	});
	it("builds suffixed branch and hashed path", () => {
		const hash = "abc1234";
		expect(guiWorktreeCandidate("x", hash, 1, "/wt")).toEqual({
			name: "x",
			branch: "omp/gui/x",
			path: path.join("/wt", `gui-x-${hash}`),
		});
		expect(guiWorktreeCandidate("x", hash, 3, "/wt").branch).toBe("omp/gui/x-3");
	});
});

describe("parsePrUnifiedDiff", () => {
	it("indexes files incl. renames, deletions and quoted paths", () => {
		const text = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1 +1 @@",
			"-x",
			"+y",
			"diff --git a/old.ts b/new.ts",
			"similarity index 100%",
			"rename from old.ts",
			"rename to new.ts",
			"diff --git a/gone.ts b/gone.ts",
			"deleted file mode 100644",
			'diff --git "a/sp ace\\303\\251.ts" "b/sp ace\\303\\251.ts"',
			"",
		].join("\n");
		const files = parsePrUnifiedDiff(text);
		expect(files.map(f => [f.path, f.oldPath])).toEqual([
			["a.ts", undefined],
			["new.ts", "old.ts"],
			["gone.ts", undefined],
			["sp aceé.ts", undefined],
		]);
		expect(text.slice(files[0]!.startOffset, files[0]!.endOffset)).toMatch(/^diff --git a\/a.ts[\s\S]*\+y\n$/);
	});
	it("decodes Git-quoted Korean UTF-8 filenames without stock gh-pr-diff mojibake", () => {
		const encoded = [...Buffer.from("한글.ts")].map(byte => `\\${byte.toString(8).padStart(3, "0")}`).join("");
		expect(parsePrUnifiedDiff(`diff --git "a/${encoded}" "b/${encoded}"\n`)[0]?.path).toBe("한글.ts");
	});
});

describe("pr draft helpers", () => {
	it("renders vars and conditional blocks", () => {
		expect(renderPrompt("{{a}}{{#if b}}[{{b}}]{{/if}}", { a: "x", b: "" })).toBe("x");
		expect(renderPrompt("{{a}}{{#if b}}[{{b}}]{{/if}}", { a: "x", b: "y" })).toBe("x[y]");
	});
	it("extracts the draft JSON around noise", () => {
		expect(extractDraftJson('Working...\n```json\n{"title":"t {x}","body":"## S\\n- a"}\n```')).toEqual({
			title: "t {x}",
			body: "## S\n- a",
		});
		expect(extractDraftJson("{bad} nothing")).toBeNull();
	});
});

describe("a PR's status check rollup", () => {
	// gh's statusCheckRollup holds check runs (status, conclusion) and commit statuses (StatusContext: context, state).
	const rollup = [
		{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
		{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: "" },
		{ __typename: "StatusContext", context: "ci/jenkins", state: "SUCCESS" },
		{ __typename: "StatusContext", context: "ci/linux", state: "FAILURE" },
		{ __typename: "StatusContext", context: "ci/windows", state: "ERROR" },
		{ __typename: "StatusContext", context: "tide", state: "PENDING" },
		{ __typename: "StatusContext", context: "deploy", state: "EXPECTED" },
	];

	it("reads a commit status's state as a check run's status and conclusion", () => {
		expect(rollupChecks(rollup)).toEqual([
			{ name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
			{ name: "build", status: "IN_PROGRESS", conclusion: null },
			{ name: "ci/jenkins", status: "COMPLETED", conclusion: "SUCCESS" },
			{ name: "ci/linux", status: "COMPLETED", conclusion: "FAILURE" },
			{ name: "ci/windows", status: "COMPLETED", conclusion: "ERROR" },
			{ name: "tide", status: "PENDING", conclusion: null },
			{ name: "deploy", status: "EXPECTED", conclusion: null },
		]);
	});

	it("counts finished commit statuses as passed or failed, not pending", () => {
		expect(rollupCounts(rollup)).toEqual({ success: 2, failure: 2, pending: 3 });
		expect(rollupCounts(null)).toEqual({ success: 0, failure: 0, pending: 0 });
	});
});
