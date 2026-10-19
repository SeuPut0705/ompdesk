/**
 * What `ompdesk_compare`, `ompdesk_merge` and the review queue know about a session's git worktree: a branch a
 * child session worked on beside the parent's checkout (`omp/agent/<slug>`, made by `worktree_create`).
 *
 * Local only (the git here runs on this computer), through the GUI's own git runner. Nothing here pushes, and a
 * merge that conflicts is aborted so the parent's checkout is never left half merged.
 */
import { realpath } from "node:fs/promises";
import { git, gitRaw } from "../local/git/exec";

/** The worktree binding of a tab (`IpcTabWorktree`): the checkout, its branch and the repo it forked from. */
export interface WorktreeRef {
	path: string;
	branch: string;
	baseCwd: string;
}

export interface FileChange {
	path: string;
	added: number;
	removed: number;
}

export interface BranchFacts {
	branch: string;
	/** The parent checkout's current branch; null while its HEAD is detached. */
	baseBranch: string | null;
	commitsAhead: number;
	/** Tracked files that differ from where the branch left the parent, committed or not. */
	files: FileChange[];
	filesTruncated: boolean;
	/** Tracked files with uncommitted edits in the worktree (a merge would leave them behind). */
	uncommitted: number;
	untracked: number;
	/** Tracked files with uncommitted edits in the parent checkout. */
	baseUncommitted: number;
	/** The branch's commits are already in the parent's branch. */
	merged: boolean;
}

export type MergeOutcome =
	| { merged: true; sha: string; summary: string }
	| { merged: false; reason: "conflict"; files: string[] };

/** A precondition that stops a merge; the message says what to do. */
export class BranchError extends Error {}

const MAX_FILES = 200;
const TIMEOUT_MS = 120_000;

async function text(cwd: string, args: string[]): Promise<string> {
	return (await git(cwd, args, { timeoutMs: TIMEOUT_MS })).trim();
}

/** `git status --porcelain` lines of tracked changes and the untracked count. */
async function dirtiness(cwd: string): Promise<{ tracked: number; untracked: number }> {
	const output = await text(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const lines = output.split("\n").filter(Boolean);
	const untracked = lines.filter(line => line.startsWith("?? ")).length;
	return { tracked: lines.length - untracked, untracked };
}

function parseNumstat(output: string): FileChange[] {
	const rows: FileChange[] = [];
	for (const line of output.split("\n")) {
		const [added, removed, ...rest] = line.split("\t");
		const file = rest.join("\t");
		if (!file) continue;
		// A binary file reports "-" for both counts.
		rows.push({ path: file, added: Number(added) || 0, removed: Number(removed) || 0 });
	}
	return rows;
}

export async function branchFacts(worktree: WorktreeRef): Promise<BranchFacts> {
	const baseBranchResult = await gitRaw(worktree.baseCwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
	const baseBranch = baseBranchResult.code === 0 ? baseBranchResult.stdout.toString("utf8").trim() || null : null;
	const baseHead = await text(worktree.baseCwd, ["rev-parse", "HEAD"]);
	const mergeBase = await text(worktree.path, ["merge-base", "HEAD", baseHead]);
	const [ahead, numstat, own, base, ancestor] = await Promise.all([
		text(worktree.path, ["rev-list", "--count", `${mergeBase}..HEAD`]),
		text(worktree.path, ["diff", "--numstat", "--no-renames", mergeBase]),
		dirtiness(worktree.path),
		dirtiness(worktree.baseCwd),
		gitRaw(worktree.baseCwd, ["merge-base", "--is-ancestor", worktree.branch, "HEAD"]),
	]);
	const files = parseNumstat(numstat);
	return {
		branch: worktree.branch,
		baseBranch,
		commitsAhead: Number(ahead) || 0,
		files: files.slice(0, MAX_FILES),
		filesTruncated: files.length > MAX_FILES,
		uncommitted: own.tracked,
		untracked: own.untracked,
		baseUncommitted: base.tracked,
		merged: ancestor.code === 0,
	};
}

export interface LandingFacts {
	/** The branch has a commit of its own (its tip is not where it was created); an untouched branch has nothing to land. */
	hasWork: boolean;
	/** Its tip is in the parent checkout's HEAD or in the remote's default branch (merged here, pushed or merged there). */
	landed: boolean;
	/** No uncommitted or untracked file in the worktree: removing it loses nothing. */
	clean: boolean;
}

/** The remote's default branch as last fetched (`refs/remotes/origin/HEAD`), or null without a remote. */
async function remoteDefault(cwd: string): Promise<string | null> {
	const result = await gitRaw(cwd, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
	return result.code === 0 ? result.stdout.toString("utf8").trim() || null : null;
}

/**
 * Whether a child's work has landed: its branch tip is an ancestor of the parent's HEAD (a local merge, a
 * fast-forward, a rebase that kept the tip) or of `origin`'s default branch (pushed to main, or merged there), and
 * whether the worktree is clean. An untouched branch is trivially an ancestor, so `hasWork` compares the tip with the
 * commit the branch was created at (its oldest reflog entry); without a reflog nothing counts as work.
 */
export async function landingFacts(worktree: WorktreeRef): Promise<LandingFacts> {
	const tipResult = await gitRaw(worktree.baseCwd, ["rev-parse", "--verify", "-q", `refs/heads/${worktree.branch}`]);
	if (tipResult.code !== 0) return { hasWork: false, landed: false, clean: false };
	const tip = tipResult.stdout.toString("utf8").trim();
	const upstream = await remoteDefault(worktree.baseCwd);
	const [head, remote, reflog, own] = await Promise.all([
		gitRaw(worktree.baseCwd, ["merge-base", "--is-ancestor", tip, "HEAD"]),
		upstream ? gitRaw(worktree.baseCwd, ["merge-base", "--is-ancestor", tip, upstream]) : null,
		gitRaw(worktree.baseCwd, ["reflog", "show", "--format=%H", `refs/heads/${worktree.branch}`]),
		dirtiness(worktree.path).catch(() => null),
	]);
	const created = reflog.stdout.toString("utf8").split("\n").filter(Boolean).at(-1);
	return {
		hasWork: created !== undefined && created !== tip,
		landed: head.code === 0 || remote?.code === 0,
		clean: own !== null && own.tracked === 0 && own.untracked === 0,
	};
}

/**
 * Remove the worktree of a session whose work landed, and its branch, losing nothing: only a registered linked
 * worktree whose branch is landed and whose files are clean goes (`worktree remove` without `--force` refuses a
 * dirty one too), and the branch only with `branch -d`, which refuses an unmerged one. A branch `-d` keeps is left alone.
 * Returns false when anything held it back.
 */
export async function removeLandedWorktree(worktree: WorktreeRef): Promise<boolean> {
	const facts = await landingFacts(worktree);
	if (!facts.hasWork || !facts.landed || !facts.clean) return false;
	const listed = (await text(worktree.baseCwd, ["worktree", "list", "--porcelain"]))
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => line.slice("worktree ".length));
	const [primary, ...linked] = await Promise.all(listed.map(entry => realpath(entry).catch(() => entry)));
	const wanted = await realpath(worktree.path).catch(() => worktree.path);
	if (!linked.includes(wanted)) return false;
	const removed = await gitRaw(primary ?? worktree.baseCwd, ["worktree", "remove", wanted], { timeoutMs: TIMEOUT_MS });
	if (removed.code !== 0) return false;
	await gitRaw(primary ?? worktree.baseCwd, ["branch", "-d", worktree.branch]);
	return true;
}

/** Why a merge of this branch cannot go ahead (what it would lose or tangle), or null. */
export function mergeProblem(worktree: WorktreeRef, facts: BranchFacts): string | null {
	if (!facts.baseBranch)
		return `The parent checkout (${worktree.baseCwd}) is on a detached HEAD; check out a branch there first.`;
	if (facts.uncommitted > 0)
		return `${worktree.branch} has ${facts.uncommitted} uncommitted file(s) in ${worktree.path}; ask that session to commit them first (ompdesk_session_send).`;
	if (facts.baseUncommitted > 0)
		return `${worktree.baseCwd} has ${facts.baseUncommitted} uncommitted file(s); commit or stash them first so the merge cannot mix with them.`;
	if (facts.merged || facts.commitsAhead === 0)
		return `${worktree.branch} has nothing to merge into ${facts.baseBranch}.`;
	return null;
}

/**
 * Merge the worktree's branch into the parent checkout's current branch with a merge commit. Refuses what a
 * merge would lose or tangle (`mergeProblem`).
 */
export async function mergeBranch(worktree: WorktreeRef, label: string): Promise<MergeOutcome> {
	const facts = await branchFacts(worktree);
	const problem = mergeProblem(worktree, facts);
	if (problem) throw new BranchError(problem);
	const message = `Merge ${worktree.branch} into ${facts.baseBranch}${label ? ` (${label})` : ""}`;
	const result = await gitRaw(worktree.baseCwd, ["merge", "--no-ff", "--no-edit", "-m", message, worktree.branch], {
		timeoutMs: TIMEOUT_MS,
	});
	if (result.code !== 0) {
		const conflicted = await gitRaw(worktree.baseCwd, ["diff", "--name-only", "--diff-filter=U"]);
		const files = conflicted.stdout.toString("utf8").split("\n").filter(Boolean);
		await gitRaw(worktree.baseCwd, ["merge", "--abort"]);
		if (files.length > 0) return { merged: false, reason: "conflict", files };
		throw new BranchError(`git merge failed: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	const sha = await text(worktree.baseCwd, ["rev-parse", "--short", "HEAD"]);
	const summary = await text(worktree.baseCwd, ["diff", "--shortstat", "HEAD~1", "HEAD"]);
	return { merged: true, sha, summary };
}

/** Remove the worktree and its branch once its session is closed; only a registered linked worktree goes. */
export async function discardWorktree(worktree: WorktreeRef): Promise<void> {
	const listed = (await text(worktree.baseCwd, ["worktree", "list", "--porcelain"]))
		.split("\n")
		.filter(line => line.startsWith("worktree "))
		.map(line => line.slice("worktree ".length));
	const [primary, ...linked] = await Promise.all(listed.map(entry => realpath(entry).catch(() => entry)));
	const wanted = await realpath(worktree.path).catch(() => worktree.path);
	if (!linked.includes(wanted))
		throw new BranchError(`${worktree.path} is not a linked worktree of ${worktree.baseCwd}; nothing was removed.`);
	await git(primary ?? worktree.baseCwd, ["worktree", "remove", "--force", wanted], { timeoutMs: TIMEOUT_MS });
	await gitRaw(primary ?? worktree.baseCwd, ["branch", "-D", worktree.branch]);
}
