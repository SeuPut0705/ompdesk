/**
 * What `ompdesk_compare`, `ompdesk_merge` and the review queue know about a session's git worktree: a branch a
 * child session worked on beside the parent's checkout (`omp/agent/<slug>`, made by `worktree_create`).
 *
 * Local only (the git here runs on this computer). Its git runs in the core process
 * (`native/ompdesk/crates/core/src/git/branches.rs`): where a branch lands and whether it landed, its facts and diff,
 * the merge prediction, the checks before a merge (`merge_problem`), the diff cut to its budget (`bound_diff`, which
 * the compare's judge shares), the merge's git steps and the removals, each one request through `coreGit`. What stays
 * here: the merge hooks around the merge and the `prepare` around a discard. Nothing here pushes, and a merge that
 * conflicts is aborted so the parent's checkout is never left half merged.
 */
import type { WorktreeSetupReport } from "../../shared/rpc-types";
import { CoreError } from "../core/process";
import { coreGit } from "../local/git/exec";
import { runWorktreeHook } from "../local/git/worktree-seed";
import type { BeforeRemove } from "../worktree-orphans";

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
	/**
	 * The branch's commits are already in the parent's branch or in the upstream it tracks (merged here, pushed or
	 * merged there): it has landed, and only uncommitted or untracked work could be left to review.
	 */
	merged: boolean;
}

/** What merging a branch into the parent checkout's HEAD would do, without doing it. */
export type MergePrediction =
	| { kind: "clean" }
	| { kind: "conflict"; files: string[] }
	| { kind: "unknown"; reason: string };

export interface BranchEvidence {
	/** The child's unified diff against where it lands (the same base `branchFacts` measures from), cut to `diffChars` fairly across files; "" when `diffChars` is 0 or nothing differs. */
	diff: string;
	/** Characters of `diff` the cut left out (0 when whole); a lower bound when git's own output cap cut it first. */
	diffOmitted: number;
	/** Merging the branch into the parent checkout's HEAD now, predicted by `git merge-tree --write-tree` with a quarantined object store. */
	merge: MergePrediction;
}

export type MergeOutcome =
	/** `postMerge`: the post-merge hook ran and failed; the merge stays. */
	| { merged: true; sha: string; summary: string; postMerge?: WorktreeSetupReport }
	/** The pre-merge hook failed or timed out: `git merge` never started. */
	| { merged: false; reason: "hook"; hook: WorktreeSetupReport }
	/** `predicted`: found by `merge-tree` before any merge ran, so the parent's checkout was never touched. */
	| { merged: false; reason: "conflict"; files: string[]; predicted: boolean };

/** A precondition that stops a merge; the message says what to do. */
export class BranchError extends Error {}

/**
 * Each request's deadline in default-timeout gits run one after another (`coreGit`; a git at the core's 120 s timeout
 * counts two). The landing judgement: three ancestry checks at once, then for the upstream and the parent's HEAD each
 * the content checks (object stores, merge-tree, the target's tree, cherry, merge-base, diff beside log, patch-id).
 */
const LANDING_ROUNDS = 1 + 2 * 11;
/** The base refs: `symbolic-ref`, then HEAD beside the upstream's. */
const BASE_ROUNDS = 3;
/** Base, landing, merge-base, then the counts at once. */
const FACTS_ROUNDS = BASE_ROUNDS + LANDING_ROUNDS + 2 + 2;
/** The branch tip, the base beside the reflog and status, the landing. */
const JUDGE_ROUNDS = 1 + BASE_ROUNDS + LANDING_ROUNDS;
/** The worktree list, then `worktree remove`. */
const REMOVE_ROUNDS = 2 + 2;

/** One request to the core; a `BranchError` of its rules keeps its class. */
async function branchGit<T>(method: string, params: object, rounds: number): Promise<T> {
	try {
		return await coreGit<T>(method, params, rounds);
	} catch (error) {
		if (error instanceof CoreError && error.code === "branch_error") throw new BranchError(error.message);
		throw error;
	}
}

export function branchFacts(worktree: WorktreeRef): Promise<BranchFacts> {
	return branchGit("git.branchFacts", { worktree }, FACTS_ROUNDS);
}

/**
 * The child's diff and what merging it would do. The diff is `git diff <mergeBase>` in its worktree, the same
 * committed plus uncommitted tracked work `branchFacts` counts, cut in the core to about `diffChars` characters fairly
 * across files (`bound_diff`, which the compare's judge shares); git's own output is capped, and a capped one still
 * counts as cut.
 */
export function branchEvidence(worktree: WorktreeRef, diffChars: number): Promise<BranchEvidence> {
	return branchGit("git.branchEvidence", { worktree, diffChars: Math.max(0, Math.floor(diffChars)) }, FACTS_ROUNDS);
}

/**
 * Whether merging the branch into the parent checkout's HEAD would conflict, asked of `git merge-tree
 * --write-tree` (idea: Orca) with a scratch object store the core makes and removes in the request.
 */
export function predictMerge(worktree: WorktreeRef): Promise<MergePrediction> {
	return branchGit("git.predictMerge", { worktree }, 4);
}

export interface LandingFacts {
	/** The branch has a commit of its own (its tip is not where it was created); an untouched branch has nothing to land. */
	hasWork: boolean;
	/** Its work is in the parent checkout's HEAD or in the upstream its branch tracks (merged here, pushed or merged there), by ancestry or by content. */
	landed: boolean;
	/** Present when `landed` by content (squash merge, rebase, cherry-pick) rather than by ancestry. */
	squashed?: true;
	/** No uncommitted or untracked file in the worktree: removing it loses nothing. */
	clean: boolean;
}

/**
 * Whether a child's work has landed: its branch tip is an ancestor of the parent's HEAD (a local merge, a
 * fast-forward, a rebase that kept the tip) or of the upstream the parent's branch tracks, else `origin`'s default
 * branch (pushed to main, or merged there), or one of them holds its changes under other commits (a squash merge, a
 * rebase, a cherry-pick: `squashed`), and whether the worktree is clean. An untouched branch is trivially an
 * ancestor, so `hasWork` compares the tip with the commit the branch was created at (its oldest reflog entry); without
 * a reflog nothing counts as work.
 */
export function landingFacts(worktree: WorktreeRef): Promise<LandingFacts> {
	return branchGit("git.landingFacts", { worktree }, JUDGE_ROUNDS);
}

/**
 * What a safe removal did: worktree and branch gone, the worktree gone but the branch kept (asked to, or it moved after
 * its landing was judged), or nothing.
 */
export type WorktreeRemoval = "removed" | "branch-kept" | null;

/**
 * Remove an agent session's worktree and its branch, losing nothing: only a registered linked worktree with no
 * uncommitted or untracked file whose work has landed in the parent's HEAD or upstream (an untouched branch has; a
 * squash-merged one has by content) goes (`worktree remove` without `--force` refuses a dirty one too). `landingFacts`
 * is the one judge of landed: the branch goes with `update-ref -d` against the very tip it judged, never `branch -d`,
 * whose own rule (merged into the parent checkout's HEAD by ancestry) kept the branch of work pushed past a parent
 * that was not pulled, or squash-merged. A branch something moved meanwhile stays (`branch-kept`), and so does one
 * `keepBranch` asks to keep. Null when anything held it back.
 */
export function removeSafeWorktree(
	worktree: WorktreeRef,
	options: { keepBranch?: boolean } = {},
): Promise<WorktreeRemoval> {
	return branchGit(
		"git.removeSafeWorktree",
		{ worktree, keepBranch: options.keepBranch === true },
		JUDGE_ROUNDS + REMOVE_ROUNDS + 1,
	);
}

/**
 * Take back a worktree and branch an open just made and nobody used: a registered linked worktree with no uncommitted
 * or untracked file (`worktree remove` without `--force`), and the branch only while its reflog still holds just the
 * entry that created it, deleted with `update-ref -d` against that very commit, so a branch something moved meanwhile
 * stays. Unlike `removeSafeWorktree` it does not ask whether the tip landed: nobody did any work on it.
 *
 * `git worktree remove` deletes ignored files without asking (a seeded `.env` someone edited, a setup hook's
 * database), so `prepare` runs first, as before every removal (disk care's `archiveBeforeRemove`): what no tool makes
 * again is archived and listed under Saved worktrees; a `prepare` that throws keeps the worktree.
 */
export async function discardNewWorktree(worktree: WorktreeRef, prepare: BeforeRemove): Promise<WorktreeRemoval> {
	const found = await branchGit<{ path: string; repo: string; tip: string } | null>(
		"git.discardCheck",
		{ worktree },
		5,
	);
	if (!found) return null;
	let settle: (removed: boolean) => Promise<void>;
	try {
		settle = await prepare({
			path: found.path,
			branch: worktree.branch,
			repo: found.repo,
			state: "untouched",
			commitsAhead: 0,
			dirtyFiles: 0,
			modifiedAt: Date.now(),
		});
	} catch {
		return null;
	}
	const removal = await branchGit<WorktreeRemoval>(
		"git.discardRemove",
		{ worktree, tip: found.tip },
		REMOVE_ROUNDS + 1,
	);
	await settle(removal !== null);
	return removal;
}

/**
 * Merge the worktree's branch into the parent checkout's current branch with a merge commit. Refuses what a
 * merge would lose or tangle (the core's `merge_problem`), and a merge `git merge-tree` predicts would conflict is
 * never started.
 * The repository's `.ompdesk/worktree-pre-merge` (in the worktree) gates it, `worktree-post-merge` (in the parent
 * checkout) runs once it landed and never undoes it.
 */
export async function mergeBranch(worktree: WorktreeRef, label: string): Promise<MergeOutcome> {
	// The facts, what a merge would lose or tangle (a `BranchError`), then the prediction: one request.
	const { baseBranch, merge: prediction } = await branchGit<{ baseBranch: string | null; merge: MergePrediction }>(
		"git.mergeCheck",
		{ worktree },
		FACTS_ROUNDS + 4,
	);
	if (prediction.kind === "conflict")
		return { merged: false, reason: "conflict", files: prediction.files, predicted: true };
	const pre = await runWorktreeHook("pre-merge", {
		primary: worktree.baseCwd,
		worktree: worktree.path,
		cwd: worktree.path,
	});
	if (pre && !pre.ok) return { merged: false, reason: "hook", hook: pre };
	// The merge (slow), the conflicted files and the abort, then the short HEAD and its summary (slow each).
	const outcome = await branchGit<MergeOutcome>("git.mergeBranch", { worktree, baseBranch, label }, 2 + 1 + 1 + 2 + 2);
	if (!outcome.merged) return outcome;
	const post = await runWorktreeHook("post-merge", {
		primary: worktree.baseCwd,
		worktree: worktree.path,
		cwd: worktree.baseCwd,
	});
	return { ...outcome, ...(post && !post.ok ? { postMerge: post } : {}) };
}
