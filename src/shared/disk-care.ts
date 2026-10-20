/**
 * Disk care: what OMPdesk's automatic disk management reports (main `src/main/disk/`, Settings › Updates & about ›
 * This computer, the agent's `disk.*` app actions). Dependency-free: main, the renderer and the web page import it.
 *
 * Each computer keeps its own disk: a paired host runs its own disk care; this contract crosses no device link.
 */

/** A worktree no one changed for this long loses the build output and dependencies its project can make again. */
export const DISK_CARE_ARTIFACT_IDLE_DAYS = 3;
/** A worktree no one changed for this long is saved (branch, private archive) and its folder removed. */
export const DISK_CARE_REMOVE_IDLE_DAYS = 14;

/** Where OMPdesk's disk goes, measured in allocated blocks (a copy-on-write clone counts in full). */
export type DiskPartId = "worktrees" | "sessions" | "ompLogs" | "stats" | "appData" | "bunCache";

export interface DiskUsagePart {
	id: DiskPartId;
	bytes: number;
	path: string;
}

export interface DiskUsage {
	measuredAt: number;
	total: number;
	parts: DiskUsagePart[];
}

/**
 * What a run did, one kind per row:
 * - `artifacts`: build output and dependencies dropped from an idle worktree (the project makes them again);
 * - `worktree-landed`: a worktree whose work is landed (or never begun) removed, branch kept;
 * - `worktree-saved`: an idle worktree with unlanded work saved to a branch and a private archive, then removed;
 * - `http-cache`: the app's own HTTP cache cleared past its size bound;
 * - `bun-cache`: Bun's install cache cleared past its size bound while no Bun process ran.
 */
export type DiskCareActionKind = "artifacts" | "worktree-landed" | "worktree-saved" | "http-cache" | "bun-cache";

export type DiskCareTrigger = "launch" | "daily" | "user" | "agent";

export interface DiskCareActionTotal {
	kind: DiskCareActionKind;
	count: number;
	/** Allocated bytes of what went (a clone's shared blocks are counted, so the disk may gain less). */
	bytes: number;
}

export interface DiskCareRunSummary {
	trigger: DiskCareTrigger;
	startedAt: number;
	endedAt: number;
	/** Sum of `actions[].bytes`. */
	freedBytes: number;
	actions: DiskCareActionTotal[];
	/** Idle worktrees left in place this run, each with its reason in the runtime log. */
	kept: number;
	failed: number;
}

export interface DiskCareState {
	running: boolean;
	/** Null until the first measurement of this launch (or the last one kept from an earlier launch). */
	usage: DiskUsage | null;
	lastRun: DiskCareRunSummary | null;
	/** Runs by themselves on this computer (a packaged app outside headless tests); the button always works. */
	automatic: boolean;
}

/** A worktree disk care saved and removed: `git worktree add` brings it back, the Work tree view's Restore puts the archive back too. */
export interface SavedWorktree {
	id: string;
	/** Where the worktree was (real path); a restore puts it there again. */
	path: string;
	/** The primary checkout of its repository. */
	repo: string;
	/** Its branch, or null on a detached HEAD. */
	branch: string | null;
	/** Its HEAD commit when it was removed. */
	head: string;
	/**
	 * The branch holding what no other ref held: the uncommitted and untracked work as one commit on top of `head`, or
	 * a detached HEAD's commits. Null when `branch` already held everything.
	 */
	savedBranch: string | null;
	/** The commit (on `savedBranch`'s line, between `head` and its tip) holding what was staged; a restore puts it back into the index. */
	staged?: string;
	removedAt: number;
	/** Files kept in the private archive (ignored or secret-looking files that never enter git). */
	archivedFiles: number;
	archivedBytes: number;
}

/** `restore_saved_worktree`: where it came back and what happened to its parts. */
export interface SavedWorktreeRestore {
	path: string;
	/** The branch checked out, or null when it came back detached (its branch moved or is checked out elsewhere). */
	branch: string | null;
	archive: { restored: number; skipped: number };
}
