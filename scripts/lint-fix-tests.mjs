#!/usr/bin/env bun
/**
 * Fix-commit lint — a commit whose subject is a fix (`fix:`, `fix(scope):`, `fix!:`) changes at least one test file,
 * or says why it cannot in its body: a line `no-test: <reason>`.
 *
 * Why: a fix without a test that fails before it is a fix nobody can tell from a regression; the regression census of
 * Oct 2026 found fixes fixed again within minutes and a test that pinned the bug as correct. A test file is a
 * `*.test.*`, `*.e2e.*` or `*.spec.*` file, or anything under `e2e/` (fixtures and harness are test code). Rust keeps
 * a module's tests in the module's own file, so a `.rs` file counts when the commit changes a line at or after its
 * `#[cfg(test)]` mark; a crate's `tests/` folder and a module's `tests.rs` or `<name>_tests.rs` (its
 * `#[cfg(test)] #[path = "<name>_tests.rs"] mod tests;`) count whole.
 *
 *   bun scripts/lint-fix-tests.mjs [<rev-range>]
 *
 * Without a range it checks this branch's commits not yet published: those origin/main lacks on `main`; on any other
 * branch those neither origin/main nor local `main` has (another session's commits on local `main` are theirs to fix,
 * and a local `main` behind origin/main must not hand this branch origin's commits). Merge commits are skipped.
 * Git runs without the repository selectors an enclosing hook or bisect exports (`withoutGitSelectors`), so it
 * reads the checkout it is run in (or `cwd`), never another one. Bun, not node: that helper is TypeScript.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withoutGitSelectors } from "../src/shared/git-env.ts";

const FIX_SUBJECT = /^fix(?:\([^)]*\))?!?:/;
const TEST_FILE =
	/(?:^|\/)[^/]+\.(?:test|e2e|spec)\.[cm]?[jt]sx?$|^e2e\/|^native\/.*\/tests\/[^/]+\.rs$|^native\/.*\/(?:[^/]+_)?tests\.rs$/;
const NO_TEST = /^no-test:\s*\S/m;
const RUST_TEST_MARK = /^\s*#\[cfg\(test\)\]/;

/**
 * @typedef {{ sha: string; subject: string; body: string; files: string[]; rustTests?: boolean }} Commit
 * @param {Commit[]} commits
 * @returns {Commit[]} the fix commits that change no test file and give no `no-test:` reason
 */
export function fixCommitsWithoutTests(commits) {
	return commits.filter(
		commit =>
			FIX_SUBJECT.test(commit.subject) &&
			!commit.files.some(file => TEST_FILE.test(file)) &&
			!commit.rustTests &&
			!NO_TEST.test(commit.body),
	);
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
const git = (args, cwd) =>
	execFileSync("git", args, { cwd, env: withoutGitSelectors(process.env), encoding: "utf8", maxBuffer: 64 << 20 });

/**
 * The default revisions: this branch's unpublished commits.
 * @param {string} [cwd]
 * @returns {string[]}
 */
export function defaultRevs(cwd) {
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
	const hasMain = (() => {
		try {
			git(["rev-parse", "--verify", "--quiet", "refs/heads/main"], cwd);
			return true;
		} catch {
			return false;
		}
	})();
	return branch === "main" || !hasMain ? ["origin/main..HEAD"] : ["HEAD", "^origin/main", "^main"];
}

/**
 * Whether commit `sha` changes a test of a Rust file it touches: a line at or after the file's `#[cfg(test)]` mark.
 * @param {string} sha
 * @param {string[]} files
 * @param {string} [cwd]
 */
export function changesRustTests(sha, files, cwd) {
	for (const file of files.filter(name => name.endsWith(".rs"))) {
		let text;
		try {
			text = git(["show", `${sha}:${file}`], cwd);
		} catch {
			continue; // the commit deleted it
		}
		const mark = text.split("\n").findIndex(line => RUST_TEST_MARK.test(line)) + 1;
		if (mark === 0) continue;
		const diff = git(["show", "--format=", "-U0", sha, "--", file], cwd);
		for (const hunk of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
			const last = Number(hunk[1]) + Math.max(hunk[2] === undefined ? 1 : Number(hunk[2]), 1) - 1;
			if (last >= mark) return true;
		}
	}
	return false;
}

/**
 * @param {string[]} revs
 * @param {string} [cwd]
 * @returns {Commit[]}
 */
export function readCommits(revs, cwd) {
	// One record per commit: NUL-separated header fields, then the changed files, records split by \x1e.
	const out = git(["log", "--no-merges", "--name-only", "--format=%x1e%H%x00%s%x00%b%x00", ...revs, "--"], cwd);
	return out
		.split("\x1e")
		.filter(Boolean)
		.map(record => {
			const [sha, subject = "", body = "", rest = ""] = record.split("\x00");
			const files = rest.split("\n").filter(Boolean);
			const rustTests = FIX_SUBJECT.test(subject) && changesRustTests(sha ?? "", files, cwd);
			return { sha: sha ?? "", subject, body, files, ...(rustTests ? { rustTests } : {}) };
		});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const revs = process.argv[2] ? [process.argv[2]] : defaultRevs();
	const range = revs.join(" ");
	const bad = fixCommitsWithoutTests(readCommits(revs));
	if (bad.length > 0) {
		console.error(`fix commits without a test (${range}):`);
		for (const commit of bad) console.error(`  ${commit.sha.slice(0, 9)} ${commit.subject}`);
		console.error(
			"A fix changes a test that fails without it; if none can, say why in the commit body: `no-test: <reason>`.",
		);
		process.exit(1);
	}
	console.log(`fix commits: every one has a test (${range})`);
}
