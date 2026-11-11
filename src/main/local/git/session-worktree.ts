/**
 * The exit half of omp's per-session worktrees (`worktree.onExit`, omp 18.8.6),
 * ported from stock `src/session/session-worktree.ts` onto the git CLI. Stock
 * plans in the omp process and removes after the session's teardown
 * (`InteractiveMode.shutdown`, interactive-mode.ts 6817-6826); a GUI tab's omp
 * is already gone by then, so main runs these steps itself. The gits and their
 * rules run in the core process (`native/ompdesk/crates/core/src/git/worktree.rs`);
 * main keeps the exit policy, the removal guard and the repository lock.
 *
 * Removal also passes OMPdesk's own guard (`removableWorktreePath`): only a
 * checkout strictly inside the worktree root it was created under, never the
 * user's clone.
 */
import { LocalCommandError } from "../types";
import { coreGit, withRepoLock } from "./exec";
import { removableWorktreePath, worktreeGit } from "./worktree";

const WORKTREE_REMOVE_TIMEOUT_MS = 120_000;

export type WorktreeOnExit = "keep" | "ask" | "remove";

/** A worktree `worktree.onStart` created (stock `SessionWorktree`, plus the root it was created under). */
export interface LifecycleWorktree {
	/** Absolute, realpath'd worktree root. */
	path: string;
	/** Branch checked out in the worktree, created from the source `HEAD`. */
	branch: string;
	/** Checkout the worktree was forked from. */
	sourceCwd: string;
	/** Source `HEAD` the branch was created at. */
	baseCommit: string;
	/** omp's worktree base (`getWorktreesDir()`) at creation: the removal guard's root. */
	root: string;
}

/** State of a session-owned worktree at exit (stock `SessionWorktreeState`). */
export interface SessionWorktreeState {
	/** Uncommitted or untracked changes. */
	dirty: boolean;
	/** Branch tip moved off `baseCommit`; the branch is kept on removal. */
	moved: boolean;
	/** Worktree `HEAD` is not the branch tip, so its commits may be on no branch. */
	offBranch: boolean;
}

export type WorktreeExitAction = "keep" | "remove" | "prompt";

/**
 * Map the `worktree.onExit` policy and the worktree's state to an exit action:
 * `remove` only removes worktrees with nothing to lose; anything else prompts.
 * Stock `decideWorktreeExit` (session-worktree.ts 56-60).
 */
export function decideWorktreeExit(policy: WorktreeOnExit, state: SessionWorktreeState): WorktreeExitAction {
	if (policy === "keep") return "keep";
	if (policy === "remove" && !state.dirty && !state.moved && !state.offBranch) return "remove";
	return "prompt";
}

/** State plus a fingerprint that changes whenever any file, ref, or `HEAD` in the worktree changes. */
export interface WorktreeSnapshot {
	state: SessionWorktreeState;
	/** Compares only with this app's own snapshots. */
	fingerprint: string;
	/** The worktree directory still exists as its own git checkout. */
	present: boolean;
}

/**
 * Stock `snapshotSessionWorktree` (session-worktree.ts 175-214). A missing
 * worktree is not dirty and not off-branch; a deleted branch has not moved; a
 * missing source repository counts as moved so the branch is never deleted.
 */
export function snapshotSessionWorktree(wt: LifecycleWorktree): Promise<WorktreeSnapshot> {
	// The source's root and branch tip, the worktree's root, its status and HEAD.
	return coreGit("git.sessionWorktreeSnapshot", { worktree: wt }, 5);
}

/**
 * Force-remove `wt`; also delete its branch unless it `moved` (has new
 * commits). Stock `removeSessionWorktree` (session-worktree.ts 308-316). A
 * vanished worktree is only pruned from git's list. Throws a user-facing error
 * when the guard or git refuses a step.
 */
export async function removeSessionWorktree(wt: LifecycleWorktree, moved: boolean): Promise<void> {
	const { primary, present } = await coreGit<{ primary: string; present: boolean }>(
		"git.sessionWorktreeRemoval",
		{ worktree: wt },
		2,
	);
	const target = present ? await removableWorktreePath(wt.path, wt.root) : null;
	if (present && !target) {
		throw new LocalCommandError(
			`Refusing to remove ${wt.path}: only worktrees under ${wt.root} can be removed.`,
			"worktree_outside_root",
		);
	}
	await withRepoLock(primary, () =>
		worktreeGit(
			"git.sessionWorktreeRemove",
			{ primary, path: wt.path, branch: wt.branch, target, moved, timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS },
			2,
			WORKTREE_REMOVE_TIMEOUT_MS,
		),
	);
}
