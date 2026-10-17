import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitSync, initRepo } from "../local/git/test-repos";
import { BranchError, branchFacts, discardWorktree, mergeBranch, type WorktreeRef } from "./branches";

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

	it("aborts a conflicting merge, names the files and leaves the parent clean", async () => {
		const wt = await agentWorktree("d");
		await commitIn(wt.path, "README.md", "from the agent\n");
		await commitIn(repo, "README.md", "from the parent\n");
		const head = gitSync(repo, "rev-parse", "HEAD");
		const outcome = await mergeBranch(wt, "Worker");
		expect(outcome).toEqual({ merged: false, reason: "conflict", files: ["README.md"] });
		expect(gitSync(repo, "rev-parse", "HEAD")).toBe(head);
		expect(gitSync(repo, "status", "--porcelain")).toBe("");
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

describe("discardWorktree", () => {
	it("removes a linked worktree and its branch, and refuses anything else", async () => {
		const wt = await agentWorktree("f");
		await fs.writeFile(path.join(wt.path, "wip.txt"), "unsaved");
		await discardWorktree(wt);
		await expect(fs.stat(wt.path)).rejects.toThrow();
		expect(gitSync(repo, "branch", "--list", wt.branch)).toBe("");
		await expect(discardWorktree({ path: repo, branch: "main", baseCwd: repo })).rejects.toBeInstanceOf(BranchError);
		expect(gitSync(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
	});
});
