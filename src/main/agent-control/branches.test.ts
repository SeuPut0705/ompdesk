import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo } from "../local/git/test-repos";
import {
	BranchError,
	boundDiff,
	branchEvidence,
	branchFacts,
	landingFacts,
	mergeBranch,
	predictMerge,
	removeSafeWorktree,
	type WorktreeRef,
} from "./branches";

let root: string;
let repo: string;

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-branches-")));
	repo = path.join(root, "repo");
	await initRepo(repo);
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** What `worktree_create` leaves: a branch off the parent's HEAD, checked out beside it. */
async function agentWorktree(name: string): Promise<WorktreeRef> {
	const branch = `omp/agent/${name}`;
	const target = path.join(root, `wt-${name}`);
	gitSync(repo, "branch", "--no-track", branch, "HEAD");
	gitSync(repo, "worktree", "add", "-q", target, branch);
	gitSync(target, "config", "user.email", "agent@example.com");
	gitSync(target, "config", "user.name", "Agent");
	return { path: target, branch, baseCwd: repo };
}

async function commitIn(dir: string, file: string, content: string): Promise<void> {
	await fs.writeFile(path.join(dir, file), content);
	gitSync(dir, "add", file);
	gitSync(dir, "commit", "-q", "-m", `edit ${file}`);
}

/**
 * The parent tracks a bare remote (`main` → `origin/main`, no `origin/HEAD`), and another clone pushed three commits
 * there that the parent fetched but never pulled: its local main is stale, as a checkout agents push past is.
 */
async function staleParentMain(): Promise<void> {
	const remote = path.join(root, "remote.git");
	gitSync(root, "init", "-q", "--bare", "-b", "main", remote);
	gitSync(repo, "remote", "add", "origin", remote);
	gitSync(repo, "push", "-q", "-u", "origin", "main");
	const other = path.join(root, "other");
	gitSync(root, "clone", "-q", remote, other);
	gitSync(other, "config", "user.email", "other@example.com");
	gitSync(other, "config", "user.name", "Other");
	for (const name of ["x.ts", "y.ts", "z.ts"]) await commitIn(other, name, `${name}\n`);
	gitSync(other, "push", "-q", "origin", "main");
	gitSync(repo, "fetch", "-q", "origin");
	// Newer git records `origin/HEAD` on fetch; drop it so only `main@{upstream}` can name the remote's main.
	gitSync(repo, "update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD");
}

/** A child cut from the parent's stale HEAD that rebased onto the remote's main (`git fetch && git rebase origin/main`). */
async function childOnRemoteMain(name: string): Promise<WorktreeRef> {
	const wt = await agentWorktree(name);
	gitSync(wt.path, "rebase", "-q", "origin/main");
	await commitIn(wt.path, "own.ts", "own\n");
	return wt;
}

describe("branchFacts", () => {
	it("reports commits, changed files with counts, uncommitted and untracked work", async () => {
		const wt = await agentWorktree("a");
		await commitIn(wt.path, "feature.ts", "one\ntwo\n");
		await fs.writeFile(path.join(wt.path, "README.md"), "hello\nmore\n");
		await fs.writeFile(path.join(wt.path, "scratch.txt"), "x");
		const facts = await branchFacts(wt);
		expect(facts).toMatchObject({
			branch: "omp/agent/a",
			baseBranch: "main",
			commitsAhead: 1,
			uncommitted: 1,
			untracked: 1,
			merged: false,
		});
		expect(facts.files).toEqual(
			expect.arrayContaining([
				{ path: "feature.ts", added: 2, removed: 0 },
				{ path: "README.md", added: 1, removed: 0 },
			]),
		);
	});

	it("sees a branch that is already in the parent, and the parent's own edits", async () => {
		const wt = await agentWorktree("b");
		await commitIn(wt.path, "x.ts", "x\n");
		gitSync(repo, "merge", "-q", "--no-edit", wt.branch);
		expect((await branchFacts(wt)).merged).toBe(true);
		await fs.writeFile(path.join(repo, "README.md"), "changed\n");
		expect((await branchFacts(wt)).baseUncommitted).toBe(1);
	});
});

describe("branchFacts against a stale parent checkout", () => {
	it("counts a child that pushed its work to the remote's main as landed, with nothing to review", async () => {
		await staleParentMain();
		const wt = await childOnRemoteMain("pushed");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		expect(await branchFacts(wt)).toMatchObject({
			commitsAhead: 0,
			files: [],
			uncommitted: 0,
			untracked: 0,
			merged: true,
		});
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: true, clean: true });
		// The parent checkout was only read: its local main still sits where it was.
		expect(gitSync(repo, "rev-list", "--count", "main..origin/main")).toBe("4");
	});

	it("measures an unpushed commit against the remote's main: one commit, its own file only", async () => {
		await staleParentMain();
		const wt = await childOnRemoteMain("unpushed");
		expect(await branchFacts(wt)).toMatchObject({
			commitsAhead: 1,
			files: [{ path: "own.ts", added: 1, removed: 0 }],
			merged: false,
		});
		expect((await landingFacts(wt)).landed).toBe(false);
	});

	it("shows only the uncommitted or untracked work a landed child left behind", async () => {
		await staleParentMain();
		const wt = await childOnRemoteMain("leftover");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		await fs.writeFile(path.join(wt.path, "own.ts"), "own\nmore\n");
		expect(await branchFacts(wt)).toMatchObject({
			commitsAhead: 0,
			files: [{ path: "own.ts", added: 1, removed: 0 }],
			uncommitted: 1,
			untracked: 0,
			merged: true,
		});
		gitSync(wt.path, "checkout", "-q", "--", "own.ts");
		await fs.writeFile(path.join(wt.path, "scratch.txt"), "x");
		expect(await branchFacts(wt)).toMatchObject({
			commitsAhead: 0,
			files: [],
			uncommitted: 0,
			untracked: 1,
			merged: true,
		});
	});
});

describe("mergeBranch", () => {
	it("merges the branch into the parent's branch with a merge commit and pushes nothing", async () => {
		const wt = await agentWorktree("c");
		await commitIn(wt.path, "feature.ts", "export const x = 1;\n");
		const outcome = await mergeBranch(wt, "Worker");
		expect(outcome).toMatchObject({ merged: true });
		expect((await fs.readFile(path.join(repo, "feature.ts"), "utf8")).replaceAll("\r\n", "\n")).toBe(
			"export const x = 1;\n",
		);
		expect(gitSync(repo, "log", "-1", "--format=%s")).toBe("Merge omp/agent/c into main (Worker)");
		expect(gitSync(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
		expect(gitSync(repo, "remote")).toBe("");
	});

	it("predicts a conflicting merge, names the files and never touches the parent's checkout", async () => {
		const wt = await agentWorktree("d");
		await commitIn(wt.path, "README.md", "from the agent\n");
		await commitIn(repo, "README.md", "from the parent\n");
		const head = gitSync(repo, "rev-parse", "HEAD");
		const origHead = path.join(repo, ".git", "ORIG_HEAD");
		const origBefore = await fs.readFile(origHead, "utf8").catch(() => null);
		const outcome = await mergeBranch(wt, "Worker");
		expect(outcome).toEqual({ merged: false, reason: "conflict", files: ["README.md"], predicted: true });
		expect(gitSync(repo, "rev-parse", "HEAD")).toBe(head);
		expect(gitSync(repo, "status", "--porcelain")).toBe("");
		expect(existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
		expect(await fs.readFile(origHead, "utf8").catch(() => null)).toBe(origBefore);
		expect((await fs.readFile(path.join(repo, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
			"from the parent\n",
		);
	});

	it("refuses to lose uncommitted work, to mix with the parent's edits, to merge nothing or into a detached HEAD", async () => {
		const wt = await agentWorktree("e");
		await expect(mergeBranch(wt, "")).rejects.toThrow(/nothing to merge/);
		await commitIn(wt.path, "a.ts", "a\n");
		await fs.writeFile(path.join(wt.path, "README.md"), "dirty\n");
		await expect(mergeBranch(wt, "")).rejects.toThrow(/uncommitted file/);
		gitSync(wt.path, "checkout", "--", "README.md");
		await fs.writeFile(path.join(repo, "README.md"), "dirty parent\n");
		await expect(mergeBranch(wt, "")).rejects.toThrow(/commit or stash/);
		gitSync(repo, "checkout", "--", "README.md");
		gitSync(repo, "checkout", "-q", "--detach");
		await expect(mergeBranch(wt, "")).rejects.toBeInstanceOf(BranchError);
		await expect(mergeBranch(wt, "")).rejects.toThrow(/detached/);
	});
});

describe("landingFacts", () => {
	it("says an untouched branch has no work to land, however trivially it sits in the parent", async () => {
		const wt = await agentWorktree("g");
		expect(await landingFacts(wt)).toEqual({ hasWork: false, landed: true, clean: true });
	});

	it("tells commits nothing merged from commits that were, by a local merge", async () => {
		const wt = await agentWorktree("h");
		await commitIn(wt.path, "a.ts", "a\n");
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: false, clean: true });
		await mergeBranch(wt, "Worker");
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: true, clean: true });
	});

	it("counts a branch pushed to the remote's default branch as landed, and reads untracked or edited files as unclean", async () => {
		const remote = path.join(root, "remote.git");
		gitSync(root, "init", "-q", "--bare", "-b", "main", remote);
		gitSync(repo, "remote", "add", "origin", remote);
		gitSync(repo, "push", "-q", "origin", "main");
		gitSync(repo, "remote", "set-head", "origin", "main");
		const wt = await agentWorktree("i");
		await commitIn(wt.path, "b.ts", "b\n");
		expect((await landingFacts(wt)).landed).toBe(false);
		gitSync(wt.path, "push", "-q", remote, `${wt.branch}:main`);
		gitSync(repo, "fetch", "-q", "origin");
		// The parent's own branch has not moved: only the remote's default knows the commit.
		expect(await landingFacts(wt)).toEqual({ hasWork: true, landed: true, clean: true });
		await fs.writeFile(path.join(wt.path, "scratch.txt"), "x");
		expect((await landingFacts(wt)).clean).toBe(false);
		await fs.rm(path.join(wt.path, "scratch.txt"));
		await fs.writeFile(path.join(wt.path, "README.md"), "edited\n");
		expect((await landingFacts(wt)).clean).toBe(false);
	});
});

describe("removeSafeWorktree", () => {
	it("removes a merged worktree and its branch without forcing, and an untouched one too", async () => {
		const wt = await agentWorktree("j");
		await commitIn(wt.path, "a.ts", "a\n");
		await mergeBranch(wt, "Worker");
		expect(await removeSafeWorktree(wt)).toBe("removed");
		await expect(fs.stat(wt.path)).rejects.toThrow();
		expect(gitSync(repo, "branch", "--list", wt.branch)).toBe("");

		// Nothing was ever done there: removing it loses nothing.
		const untouched = await agentWorktree("m");
		expect(await removeSafeWorktree(untouched)).toBe("removed");
		await expect(fs.stat(untouched.path)).rejects.toThrow();
	});

	it("keeps everything for unmerged commits, uncommitted or untracked files and a main checkout", async () => {
		const unmerged = await agentWorktree("k");
		await commitIn(unmerged.path, "a.ts", "a\n");
		expect(await removeSafeWorktree(unmerged)).toBeNull();
		await fs.stat(unmerged.path);

		const dirty = await agentWorktree("l");
		await commitIn(dirty.path, "b.ts", "b\n");
		await mergeBranch(dirty, "Worker");
		await fs.writeFile(path.join(dirty.path, "scratch.txt"), "unsaved");
		expect(await removeSafeWorktree(dirty)).toBeNull();
		expect(await fs.readFile(path.join(dirty.path, "scratch.txt"), "utf8")).toBe("unsaved");
		expect(gitSync(repo, "branch", "--list", dirty.branch)).toContain(dirty.branch);

		expect(await removeSafeWorktree({ path: repo, branch: "main", baseCwd: repo })).toBeNull();
	});
});

describe("boundDiff", () => {
	const section = (file: string, lines: number): string =>
		`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${Array.from({ length: lines }, (_, i) => `+line ${i}\n`).join("")}`;

	it("returns the whole diff when it fits and nothing when there is no budget", () => {
		const diff = section("a.ts", 3);
		expect(boundDiff(diff, diff.length)).toEqual({ text: diff, omitted: 0 });
		expect(boundDiff(diff, 0)).toEqual({ text: "", omitted: diff.length });
		expect(boundDiff("", 100)).toEqual({ text: "", omitted: 0 });
	});

	it("gives a small source file its whole hunk however big the lockfile beside it is", () => {
		const source = section("src/app.ts", 4);
		const lock = section("package-lock.json", 5000);
		const { text, omitted } = boundDiff(lock + source, 2000);
		expect(text).toContain(source);
		expect(text).toMatch(/… \d+ more lines of package-lock\.json left out\n/);
		expect(text.length).toBeLessThanOrEqual(2000);
		expect(omitted).toBeGreaterThan(0);
		expect(omitted).toBe(lock.length + source.length - text.replace(/… .* left out\n/, "").length);
	});

	it("cuts at a line boundary and says how many lines it left out", () => {
		const { text } = boundDiff(section("big.ts", 100), 300);
		expect(text.endsWith(" left out\n")).toBe(true);
		const kept = text.split("\n").filter(line => line.startsWith("+line "));
		expect(kept.every(line => /^\+line \d+$/.test(line))).toBe(true);
		const left = Number(/… (\d+) more line/.exec(text)?.[1]);
		expect(kept.length + left).toBe(100);
	});
});

describe("branchEvidence", () => {
	it("carries the child's diff against where it lands, cut to the budget, and the merge prediction", async () => {
		const wt = await agentWorktree("ev");
		await commitIn(wt.path, "feature.ts", "export const added = 1;\n");
		await fs.writeFile(path.join(wt.path, "README.md"), "hello\nuncommitted line\n");
		const evidence = await branchEvidence(wt, 10_000);
		expect(evidence.diff).toContain("+export const added = 1;");
		expect(evidence.diff).toContain("+uncommitted line");
		expect(evidence.diffOmitted).toBe(0);
		expect(evidence.merge).toEqual({ kind: "clean" });
	});

	it("skips the diff at a budget of 0 and reports a cut one", async () => {
		const wt = await agentWorktree("ev0");
		await commitIn(wt.path, "feature.ts", `${"x".repeat(80)}\n`.repeat(50));
		expect(await branchEvidence(wt, 0)).toMatchObject({ diff: "", diffOmitted: 0 });
		const cut = await branchEvidence(wt, 400);
		expect(cut.diff.length).toBeLessThanOrEqual(400);
		expect(cut.diffOmitted).toBeGreaterThan(0);
	});
});

describe("predictMerge", () => {
	it("names the file two branches changed on the same lines, and calls disjoint work clean", async () => {
		const clashing = await agentWorktree("clash");
		await commitIn(clashing.path, "README.md", "from the agent\n");
		const disjoint = await agentWorktree("apart");
		await commitIn(disjoint.path, "feature.ts", "x\n");
		await commitIn(repo, "README.md", "from the parent\n");
		expect(await predictMerge(clashing)).toEqual({ kind: "conflict", files: ["README.md"] });
		expect(await predictMerge(disjoint)).toEqual({ kind: "clean" });
	});

	it("says unknown for a branch that no longer exists", async () => {
		const wt = await agentWorktree("gone");
		const result = await predictMerge({ ...wt, branch: "omp/agent/missing" });
		expect(result.kind).toBe("unknown");
	});

	it("writes its merged tree to a scratch store: the repo's object counts, status and HEAD stay as they were", async () => {
		const wt = await agentWorktree("quiet");
		await commitIn(wt.path, "feature.ts", "from the agent\n");
		await commitIn(repo, "other.ts", "from the parent\n");
		const counts = () =>
			gitSync(repo, "count-objects", "-v")
				.split("\n")
				.filter(line => /^(count|in-pack):/.test(line));
		const head = gitSync(repo, "rev-parse", "HEAD");
		const before = counts();
		expect(before).toHaveLength(2);
		expect(await predictMerge(wt)).toEqual({ kind: "clean" });
		expect(counts()).toEqual(before);
		expect(gitSync(repo, "status", "--porcelain")).toBe("");
		expect(gitSync(repo, "rev-parse", "HEAD")).toBe(head);
	});
});
