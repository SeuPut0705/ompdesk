/**
 * `worktree_create` / `worktree_remove` over the git CLI (port of fork rpc-worktree.ts).
 * GUI worktrees live on branch `omp/gui/<slug>` at `~/.omp/wt/gui-<slug>-<hash7(primaryRoot)>`,
 * alongside omp's task and PR worktrees; collisions suffix `-2..-100` on path and branch.
 * The bound branch is never deleted on remove, and nothing outside that root is ever removed.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RpcWorktreeCreateResult } from "../../../shared/rpc-types";
import { LocalCommandError } from "../types";
import { getGitStatus, primaryRoot, repoRoot } from "./changes";
import { DEFAULT_TIMEOUT_MS, git, gitRaw, withRepoLock } from "./exec";
import { guiWorktreeCandidate, isInside, worktreeSlug, worktreesDir } from "./parse";

const MAX_SUFFIX = 100;
/** `git worktree add` checks out the whole tree: minutes on a large repository. */
export const WORKTREE_ADD_TIMEOUT_MS = 300_000;
const WORKTREE_REMOVE_TIMEOUT_MS = 120_000;
/**
 * Longest each command runs before main answers, counting every git step on
 * its slowest path at that step's timeout. The renderer's RPC timeouts
 * (shared/rpc-client.ts) must not be shorter, or it reports a failure while
 * the work still lands.
 */
export const WORKTREE_COMMAND_BUDGETS_MS = {
	// Repo root, primary root, default branch, branch probe, `git branch`, the
	// branch rollback when `worktree add` fails, and `worktree add` itself.
	worktree_create: 6 * DEFAULT_TIMEOUT_MS + WORKTREE_ADD_TIMEOUT_MS,
	// Repo root, primary root, status, prune, and `worktree remove` itself.
	worktree_remove: 4 * DEFAULT_TIMEOUT_MS + WORKTREE_REMOVE_TIMEOUT_MS,
} as const;

/** Remote default branch (`origin/main`), or null when origin/HEAD is unset. */
export async function defaultBranchRef(cwd: string): Promise<string | null> {
	const result = await gitRaw(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	return result.code === 0 ? result.stdout.toString("utf8").trim() || null : null;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
	return (await gitRaw(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

async function pathTaken(file: string): Promise<boolean> {
	return fs.stat(file).then(
		() => true,
		() => false,
	);
}

export async function createWorktree(
	sessionCwd: string,
	input: { name: string; baseCwd?: string; baseRef?: "HEAD" | "default" },
): Promise<RpcWorktreeCreateResult> {
	const slug = worktreeSlug(input.name);
	if (!slug) {
		throw new LocalCommandError(
			`Invalid worktree name "${input.name}" — use 1-41 chars of [a-z0-9-], starting with a letter or digit.`,
			"invalid_name",
		);
	}
	const baseCwd = input.baseCwd ?? sessionCwd;
	if (!(await repoRoot(baseCwd))) throw new LocalCommandError(`Not a git repository: ${baseCwd}`, "not_a_repo");
	const primary = await primaryRoot(baseCwd);
	const startPoint = input.baseRef === "default" ? ((await defaultBranchRef(primary)) ?? "HEAD") : "HEAD";

	return withRepoLock(primary, async () => {
		for (let suffix = 1; suffix <= MAX_SUFFIX; suffix++) {
			const candidate = guiWorktreeCandidate(slug, primary, suffix);
			// A half-created dir (no .git yet) still makes `git worktree add` fail with "exists".
			if ((await pathTaken(candidate.path)) || (await branchExists(primary, candidate.branch))) continue;
			try {
				await fs.mkdir(path.dirname(candidate.path), { recursive: true });
				await git(baseCwd, ["branch", "--no-track", candidate.branch, startPoint]);
				await git(primary, ["worktree", "add", candidate.path, candidate.branch], {
					timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
				});
			} catch (error) {
				// Roll back the branch so a retry does not trip over the half-created ref.
				await gitRaw(primary, ["branch", "-D", candidate.branch]).catch(() => undefined);
				throw new LocalCommandError(
					`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
					"worktree_create_failed",
				);
			}
			return { path: candidate.path, branch: candidate.branch, baseCwd: primary };
		}
		throw new LocalCommandError(`No available worktree name after ${MAX_SUFFIX} attempts`, "worktree_create_failed");
	});
}

/**
 * Real path of `worktreePath` when it lies strictly inside `root` (the
 * directory every GUI and PR worktree is created under), else null. Both sides
 * are resolved first, so neither `..` segments nor a symlink inside the root
 * can reach a checkout elsewhere.
 */
export async function removableWorktreePath(
	worktreePath: string,
	root: string = worktreesDir(),
): Promise<string | null> {
	if (!worktreePath || !path.isAbsolute(worktreePath)) return null;
	try {
		const [realRoot, realPath] = await Promise.all([fs.realpath(root), fs.realpath(worktreePath)]);
		return isInside(realRoot, realPath) ? realPath : null;
	} catch {
		// A missing root or path holds nothing this command may remove.
		return null;
	}
}

/**
 * Dirty worktrees are refused unless `force`; the message carries the counts for the close dialog.
 * Only checkouts under the worktree root qualify: `--force` must never reach the user's own clone.
 */
export async function removeWorktree(input: { path: string; force?: boolean }): Promise<{ removed: true }> {
	const worktreePath = await removableWorktreePath(input.path);
	if (!worktreePath) {
		throw new LocalCommandError(
			`Refusing to remove ${input.path || "(no path)"}: only worktrees under ${worktreesDir()} can be removed.`,
			"worktree_outside_root",
		);
	}
	if (!(await repoRoot(worktreePath).catch(() => null))) {
		throw new LocalCommandError(`Not inside a git worktree: ${worktreePath}`, "not_a_worktree");
	}
	const primary = await primaryRoot(worktreePath);
	if (!input.force) {
		const status = await getGitStatus(worktreePath);
		if (status.staged > 0 || status.unstaged > 0 || status.untracked > 0) {
			throw new LocalCommandError(
				`Worktree has uncommitted changes: ${status.staged} staged, ${status.unstaged} unstaged, ${status.untracked} untracked.`,
				"worktree_dirty",
			);
		}
	}
	return withRepoLock(primary, async () => {
		const removed = await gitRaw(primary, ["worktree", "remove", "--force", worktreePath], {
			timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
		});
		if (removed.code !== 0) {
			throw new LocalCommandError(
				`git worktree remove failed: ${worktreePath}${removed.stderr.trim() ? ` (${removed.stderr.trim()})` : ""}`,
				"worktree_remove_failed",
			);
		}
		await gitRaw(primary, ["worktree", "prune"]);
		return { removed: true as const };
	});
}
