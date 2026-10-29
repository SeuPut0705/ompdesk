import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixCommitsWithoutTests, readCommits } from "./lint-fix-tests.mjs";

const commit = (subject, files, body = "") => ({ sha: subject, subject, body, files });

describe("fixCommitsWithoutTests", () => {
	it("flags a fix of any conventional form that touches no test", () => {
		const bad = [
			commit("fix: a row wraps", ["src/renderer/Row.tsx"]),
			commit("fix(work): an ls is no failure", ["src/renderer/work.ts"]),
			commit("fix!: drop the old flag", ["src/main/flags.ts"]),
		];
		expect(fixCommitsWithoutTests(bad).map(c => c.subject)).toEqual(bad.map(c => c.subject));
	});

	it("accepts a fix with a unit test, an e2e spec or e2e support, and a reasoned no-test line", () => {
		expect(
			fixCommitsWithoutTests([
				commit("fix: a", ["src/main/a.ts", "src/main/a.test.ts"]),
				commit("fix: b", ["src/renderer/B.tsx", "src/renderer/B.test.tsx"]),
				commit("fix: c", ["scripts/lint-x.mjs", "scripts/lint-x.test.mjs"]),
				commit("fix: d", ["e2e/work-board.e2e.ts"]),
				commit("fix: e", ["e2e/fixture/rpc-ui.ts"]),
				commit("fix: f", ["src/renderer/locales/ko.ts"], "Wording.\n\nno-test: a translation, no behavior"),
			]),
		).toEqual([]);
	});

	it("needs a reason after no-test, and ignores what is not a fix", () => {
		expect(fixCommitsWithoutTests([commit("fix: a", ["src/a.ts"], "no-test:")])).toHaveLength(1);
		expect(
			fixCommitsWithoutTests([
				commit("feat: a", ["src/a.ts"]),
				commit("refactor(fix): a", ["src/a.ts"]),
				commit("fixup! fix: a", ["src/a.ts"]),
				commit("release: v1.2.3", ["package.json"]),
			]),
		).toEqual([]);
	});

	it("does not count a file merely named like a test outside a test suffix", () => {
		expect(fixCommitsWithoutTests([commit("fix: a", ["src/main/test-repos.ts", "src/main/latest.ts"])])).toHaveLength(
			1,
		);
	});
});

describe("readCommits", () => {
	const dirs = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
	/** A fresh repository on `main` with one commit, and a git runner in it. */
	const newRepo = () => {
		const dir = mkdtempSync(path.join(tmpdir(), "lint-fix-tests-"));
		dirs.push(dir);
		const git = (...args) =>
			execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
				cwd: dir,
				env,
				encoding: "utf8",
			});
		git("init", "-q", "-b", "main");
		writeFileSync(path.join(dir, "base.txt"), "base");
		git("add", ".");
		git("commit", "-q", "-m", "chore: base");
		return { dir, git };
	};

	it("reads subject, body and files of each non-merge commit in a range, in its own checkout whatever git selectors are set", () => {
		const { dir: repo, git } = newRepo();
		git("checkout", "-q", "-b", "work");
		mkdirSync(path.join(repo, "src"));
		writeFileSync(path.join(repo, "src", "a.ts"), "a");
		git("add", ".");
		git("commit", "-q", "-m", "fix: a breaks", "-m", "Body line.\n\nno-test: none possible");
		writeFileSync(path.join(repo, "src", "a.test.ts"), "t");
		writeFileSync(path.join(repo, "src", "b.ts"), "b");
		git("add", ".");
		git("commit", "-q", "-m", "fix(b): b breaks");
		git("checkout", "-q", "main");
		git("merge", "-q", "--no-ff", "work", "-m", "fix: a merge is skipped");
		// A hook or `git bisect run` exports selectors for another repository (one commit, no HEAD~1).
		const other = newRepo();
		vi.stubEnv("GIT_DIR", path.join(other.dir, ".git"));
		vi.stubEnv("GIT_WORK_TREE", other.dir);

		const commits = readCommits("HEAD~1..HEAD", repo);
		expect(commits.map(({ subject, body, files }) => ({ subject, body: body.trim(), files }))).toEqual([
			{ subject: "fix(b): b breaks", body: "", files: ["src/a.test.ts", "src/b.ts"] },
			{ subject: "fix: a breaks", body: "Body line.\n\nno-test: none possible", files: ["src/a.ts"] },
		]);
		expect(fixCommitsWithoutTests(commits)).toEqual([]);
	});
});
