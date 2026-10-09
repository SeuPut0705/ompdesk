/**
 * The exit half of omp's per-session worktrees (`worktree.onExit`, omp 18.8.6),
 * ported from stock `src/session/session-worktree.ts` onto the git CLI. Stock
 * plans in the omp process and removes after the session's teardown
 * (`InteractiveMode.shutdown`, interactive-mode.ts 6817-6826); a GUI tab's omp
 * is already gone by then, so main runs these steps itself.
 *
 * Removal also passes OMPdesk's own guard (`removableWorktreePath`): only a
 * checkout strictly inside the worktree root it was created under, never the
 * user's clone.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LocalCommandError } from "../types";
import { primaryRoot, repoRoot } from "./changes";
import { gitRaw, withRepoLock } from "./exec";
import { removableWorktreePath } from "./worktree";

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
	fingerprint: string;
	/** The worktree directory still exists as its own git checkout. */
	present: boolean;
}

async function revParse(cwd: string, ref: string): Promise<string | null> {
	const result = await gitRaw(cwd, ["rev-parse", "--verify", "--quiet", ref]);
	return result.code === 0 ? result.stdout.toString("utf8").trim() || null : null;
}

/** True when `dir` is itself a checkout root (a parent repository does not count). */
async function isCheckoutRoot(dir: string): Promise<boolean> {
	const [top, real] = await Promise.all([repoRoot(dir).catch(() => null), fs.realpath(dir).catch(() => null)]);
	if (!top || !real) return false;
	return (await fs.realpath(top).catch(() => top)) === real;
}

function hashParts(parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(part).update("\0");
	return hash.digest("hex");
}

/**
 * Stock `snapshotSessionWorktree` (session-worktree.ts 175-214). A missing
 * worktree is not dirty and not off-branch; a deleted branch has not moved; a
 * missing source repository counts as moved so the branch is never deleted.
 */
export async function snapshotSessionWorktree(wt: LifecycleWorktree): Promise<WorktreeSnapshot> {
	let moved = true;
	let tip: string | null = null;
	if (await repoRoot(wt.sourceCwd).catch(() => null)) {
		tip = await revParse(wt.sourceCwd, `refs/heads/${wt.branch}`);
		moved = tip !== null && tip !== wt.baseCommit;
	}
	if (!(await isCheckoutRoot(wt.path))) {
		return { state: { dirty: false, moved, offBranch: false }, fingerprint: `missing\0${tip ?? ""}`, present: false };
	}
	const statusResult = await gitRaw(wt.path, ["status", "--porcelain", "-z", "--untracked-files=all"]);
	if (statusResult.code !== 0) {
		throw new Error(
			`git status failed in ${wt.path}${statusResult.stderr.trim() ? `: ${statusResult.stderr.trim()}` : ""}`,
		);
	}
	const status = statusResult.stdout.toString("utf8");
	const head = await revParse(wt.path, "HEAD");
	// Porcelain codes do not change when an already-modified file is edited
	// again, so fold in each changed path's size and mtime.
	const parts = [head ?? "", tip ?? "", status];
	const entries = status.split("\0");
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		// Renames and copies are followed by their source path as a separate entry.
		if (entry[0] === "R" || entry[0] === "C") i++;
		const file = entry.slice(3);
		const stat = await fs.stat(path.join(wt.path, file)).catch(() => undefined);
		parts.push(stat ? `${file}:${stat.size}:${stat.mtimeMs}` : `${file}:-`);
	}
	return {
		state: { dirty: status.length > 0, moved, offBranch: Boolean(head) && head !== tip },
		fingerprint: hashParts(parts),
		present: true,
	};
}

/**
 * Force-remove `wt`; also delete its branch unless it `moved` (has new
 * commits). Stock `removeSessionWorktree` (session-worktree.ts 308-316). A
 * vanished worktree is only pruned from git's list. Throws a user-facing error
 * when the guard or git refuses a step.
 */
export async function removeSessionWorktree(wt: LifecycleWorktree, moved: boolean): Promise<void> {
	const primary = await primaryRoot(wt.sourceCwd);
	const present = await isCheckoutRoot(wt.path);
	const target = present ? await removableWorktreePath(wt.path, wt.root) : null;
	if (present && !target) {
		throw new LocalCommandError(
			`Refusing to remove ${wt.path}: only worktrees under ${wt.root} can be removed.`,
			"worktree_outside_root",
		);
	}
	await withRepoLock(primary, async () => {
		if (target) {
			const removed = await gitRaw(primary, ["worktree", "remove", "--force", target], {
				timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
			});
			if (removed.code !== 0) {
				throw new LocalCommandError(
					`Failed to remove worktree ${wt.path}; branch '${wt.branch}' kept.`,
					"worktree_remove_failed",
				);
			}
		}
		await gitRaw(primary, ["worktree", "prune"]);
		if (!moved && (await gitRaw(primary, ["branch", "-D", wt.branch])).code !== 0) {
			throw new LocalCommandError(
				`Removed worktree ${wt.path} but failed to delete branch '${wt.branch}'.`,
				"worktree_remove_failed",
			);
		}
	});
}
