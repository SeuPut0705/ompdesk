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
import { WORKTREE_HOOK_SCRIPTS } from "../local/git/worktree-seed";
import { BranchError, landingFacts, mergeBranch, removeSafeWorktree } from "./branches";
import {
	agentWorktree,
	childOnRemoteMain,
	commitIn,
	installBranchesRig,
	repo,
	root,
	staleParentMain,
} from "./branches-test-rig";

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

describe.skipIf(process.platform === "win32")("mergeBranch hooks", () => {
	async function hookedWorktree(name: string, hooks: Partial<Record<"pre-merge" | "post-merge", string>>) {
		await fs.mkdir(path.join(repo, ".ompdesk"), { recursive: true });
		for (const [hook, body] of Object.entries(hooks))
			await fs.writeFile(path.join(repo, WORKTREE_HOOK_SCRIPTS[hook as "pre-merge"]), body);
		gitSync(repo, "add", ".ompdesk");
		gitSync(repo, "commit", "-q", "-m", "hooks");
		const wt = await agentWorktree(name);
		await commitIn(wt.path, "feature.ts", "export const x = 1;\n");
		return wt;
	}

	it("merges when pre-merge exits 0, with no postMerge report", async () => {
		const wt = await hookedWorktree("hk1", { "pre-merge": "exit 0\n", "post-merge": "exit 0\n" });
		const outcome = await mergeBranch(wt, "Worker");
		expect(outcome).toMatchObject({ merged: true });
		expect(outcome).not.toHaveProperty("postMerge");
	});

	it("never starts git merge when pre-merge fails, and runs it in the worktree", async () => {
		const wt = await hookedWorktree("hk2", { "pre-merge": "pwd\necho nope >&2\nexit 7\n" });
		const head = gitSync(repo, "rev-parse", "HEAD");
		const outcome = await mergeBranch(wt, "Worker");
		expect(outcome).toMatchObject({ merged: false, reason: "hook", hook: { ok: false, exitCode: 7 } });
		if (outcome.merged || outcome.reason !== "hook") throw new Error("expected a hook outcome");
		expect(outcome.hook.outputTail).toContain(await fs.realpath(wt.path));
		expect(outcome.hook.outputTail).toContain("nope");
		expect(gitSync(repo, "rev-parse", "HEAD")).toBe(head);
		expect(existsSync(path.join(repo, "feature.ts"))).toBe(false);
	});

	it("keeps the merge when post-merge fails, and runs it in the parent checkout", async () => {
		const wt = await hookedWorktree("hk3", { "post-merge": "pwd\nexit 5\n" });
		const outcome = await mergeBranch(wt, "Worker");
		expect(outcome).toMatchObject({ merged: true, postMerge: { ok: false, exitCode: 5 } });
		if (!outcome.merged) throw new Error("expected a merge");
		expect(outcome.postMerge?.outputTail).toContain(await fs.realpath(repo));
		expect(gitSync(repo, "log", "-1", "--format=%s")).toBe("Merge omp/agent/hk3 into main (Worker)");
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

	it("removes the branch of work that landed upstream while the parent checkout's HEAD is behind it", async () => {
		await staleParentMain();
		const wt = await childOnRemoteMain("pushed");
		gitSync(wt.path, "push", "-q", "origin", "HEAD:main");
		expect(await removeSafeWorktree(wt)).toBe("removed");
		await expect(fs.stat(wt.path)).rejects.toThrow();
		expect(gitSync(repo, "branch", "--list", wt.branch)).toBe("");
	});

	it("keeps a branch that moved after its landing was judged, and the commit it moved to", async () => {
		const wt = await agentWorktree("moved");
		await commitIn(wt.path, "a.ts", "a\n");
		await mergeBranch(wt, "Worker");
		const tip = gitSync(repo, "rev-parse", wt.branch).trim();
		const moved = gitSync(repo, "commit-tree", `${tip}^{tree}`, "-p", tip, "-m", "moved").trim();
		// The worktree's `git status` (the judgement's clean check) runs this hook once: the branch moves to a commit of
		// the same tree right after its tip was read, so the worktree stays clean and goes while the branch must stay.
		const slash = (file: string) => file.replaceAll("\\", "/");
		const mark = path.join(root, "moved.mark");
		const hook = path.join(root, "fsmonitor-hook");
		await fs.writeFile(
			hook,
			`#!/bin/sh\n[ -e "${slash(mark)}" ] && exit 1\n: > "${slash(mark)}"\ngit -C "${slash(repo)}" update-ref refs/heads/${wt.branch} ${moved} ${tip}\nexit 1\n`,
			{ mode: 0o755 },
		);
		gitSync(repo, "config", "core.fsmonitor", slash(hook));
		expect(await removeSafeWorktree(wt)).toBe("branch-kept");
		expect(existsSync(mark)).toBe(true);
		await expect(fs.stat(wt.path)).rejects.toThrow();
		expect(gitSync(repo, "rev-parse", wt.branch).trim()).toBe(moved);
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
