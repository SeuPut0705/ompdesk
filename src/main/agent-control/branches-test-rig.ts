import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { gitSync, initRepo } from "../local/git/test-repos";
import type { WorktreeRef } from "./branches";

export let root: string;
export let repo: string;

/** What `worktree_create` leaves: a branch off the parent's HEAD, checked out beside it. */
export async function agentWorktree(name: string): Promise<WorktreeRef> {
	const branch = `omp/agent/${name}`;
	const target = path.join(root, `wt-${name}`);
	gitSync(repo, "branch", "--no-track", branch, "HEAD");
	gitSync(repo, "worktree", "add", "-q", target, branch);
	gitSync(target, "config", "user.email", "agent@example.com");
	gitSync(target, "config", "user.name", "Agent");
	return { path: target, branch, baseCwd: repo };
}

export async function commitIn(dir: string, file: string, content: string): Promise<void> {
	await fs.writeFile(path.join(dir, file), content);
	gitSync(dir, "add", file);
	gitSync(dir, "commit", "-q", "-m", `edit ${file}`);
}

/**
 * The parent tracks a bare remote (`main` → `origin/main`, no `origin/HEAD`), and another clone pushed three commits
 * there that the parent fetched but never pulled: its local main is stale, as a checkout agents push past is.
 */
export async function staleParentMain(): Promise<void> {
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
export async function childOnRemoteMain(name: string): Promise<WorktreeRef> {
	const wt = await agentWorktree(name);
	gitSync(wt.path, "rebase", "-q", "origin/main");
	await commitIn(wt.path, "own.ts", "own\n");
	return wt;
}

/** What a squash-merge PR does: one new commit on the parent's main holding the branch's net change; the branch's own commits are in no ancestry. */
export function squashMerge(wt: WorktreeRef): void {
	gitSync(repo, "merge", "--squash", wt.branch);
	gitSync(repo, "commit", "-q", "-m", `squash ${wt.branch}`);
}

/** Registers the shared hooks: a fresh repository for each test. */
export function installBranchesRig(): void {
	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-branches-")));
		repo = path.join(root, "repo");
		await initRepo(repo);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});
}
