#!/usr/bin/env node
/**
 * Fix-commit lint — a commit whose subject is a fix (`fix:`, `fix(scope):`, `fix!:`) changes at least one test file,
 * or says why it cannot in its body: a line `no-test: <reason>`.
 *
 * Why: a fix without a test that fails before it is a fix nobody can tell from a regression; the regression census of
 * Oct 2026 found fixes fixed again within minutes and a test that pinned the bug as correct. A test file is a
 * `*.test.*`, `*.e2e.*` or `*.spec.*` file, or anything under `e2e/` (fixtures and harness are test code).
 *
 *   node scripts/lint-fix-tests.mjs [<rev-range>]
 *
 * Without a range it checks this branch's commits not yet published: `origin/main..HEAD` on `main`, `main..HEAD`
 * on any other branch (another session's commits on local `main` are theirs to fix). Merge commits are skipped.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FIX_SUBJECT = /^fix(?:\([^)]*\))?!?:/;
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|e2e|spec)\.[cm]?[jt]sx?$|^e2e\//;
const NO_TEST = /^no-test:\s*\S/m;

/**
 * @typedef {{ sha: string; subject: string; body: string; files: string[] }} Commit
 * @param {Commit[]} commits
 * @returns {Commit[]} the fix commits that change no test file and give no `no-test:` reason
 */
export function fixCommitsWithoutTests(commits) {
	return commits.filter(
		commit =>
			FIX_SUBJECT.test(commit.subject) &&
			!commit.files.some(file => TEST_FILE.test(file)) &&
			!NO_TEST.test(commit.body),
	);
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 */
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });

/** The default range: this branch's unpublished commits. */
function defaultRange() {
	const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	const hasMain = (() => {
		try {
			git(["rev-parse", "--verify", "--quiet", "refs/heads/main"]);
			return true;
		} catch {
			return false;
		}
	})();
	return branch === "main" || !hasMain ? "origin/main..HEAD" : "main..HEAD";
}

/**
 * @param {string} range
 * @param {string} [cwd]
 * @returns {Commit[]}
 */
export function readCommits(range, cwd) {
	// One record per commit: NUL-separated header fields, then the changed files, records split by \x1e.
	const out = git(["log", "--no-merges", "--name-only", "--format=%x1e%H%x00%s%x00%b%x00", range, "--"], cwd);
	return out
		.split("\x1e")
		.filter(Boolean)
		.map(record => {
			const [sha = "", subject = "", body = "", rest = ""] = record.split("\x00");
			return { sha, subject, body, files: rest.split("\n").filter(Boolean) };
		});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const range = process.argv[2] ?? defaultRange();
	const bad = fixCommitsWithoutTests(readCommits(range));
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
