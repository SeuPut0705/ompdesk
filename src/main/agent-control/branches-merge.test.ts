/**
 * Landing a child's branch: `mergeBranch`, `landingFacts` and `removeSafeWorktree` on real temp repos. Split from
 * `branches.test.ts` (which keeps `branchFacts`) so the two files' git runs go side by side: one file of 13 cases was the
 * Windows platform job's longest, 51 s.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync } from "../local/git/test-repos";
import { BranchError, landingFacts, mergeBranch, removeSafeWorktree } from "./branches";
import { agentWorktree, commitIn, installBranchesRig, repo, root } from "./branches-test-rig";

installBranchesRig();

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
