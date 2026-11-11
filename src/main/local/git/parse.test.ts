import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	extractDraftJson,
	guiWorktreeCandidate,
	isInside,
	isSafeRelativePath,
	parseGitStatus,
	renderPrompt,
	worktreeSlug,
} from "./parse";

// parseStatusV2 and newFileDiff moved to the core process with their cases (native/ompdesk/crates/core/src/git/parse.rs),
// parsePrUnifiedDiff, rollupChecks and rollupCounts with theirs (native/ompdesk/crates/core/src/gh/pr.rs).

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
