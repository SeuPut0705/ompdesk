/**
 * `worktree_create` / `worktree_remove` over the git CLI (port of fork rpc-worktree.ts).
 * GUI naming uses stock's canonical worktree base and repo hash through the bridge.
 * Collisions suffix `-2..-100` on path and branch. Removal keeps the branch and
 * requires a linked checkout registered by git under the canonical root.
 * Kept over stock createSessionWorktree: GUI names/baseRef differ and never carry
 * uncommitted changes. Removal deliberately retains branches; session exit safety
 * still runs in main after omp has gone, unlike stock removeExitWorktrees.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RpcWorktreeCreateResult } from "../../../shared/rpc-types";
import { worktreeBranchPrefix } from "../../../shared/worktree-branch";
import { stockHelperRequest } from "../../stock-helper";
import { type BridgeClient, LocalCommandError } from "../types";
import { getGitStatus, primaryRoot, repoRoot } from "./changes";
import { DEFAULT_TIMEOUT_MS, git, gitRaw, withRepoLock } from "./exec";
import { guiWorktreeCandidate, isInside, worktreeSlug } from "./parse";
import { prepareWorktree, WORKTREE_PREPARE_BUDGET_MS } from "./worktree-seed";

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
	// branch rollback when `worktree add` fails, `worktree add` itself, then
	// seeding and the setup hook (`worktree-seed.ts`).
	worktree_create: 6 * DEFAULT_TIMEOUT_MS + WORKTREE_ADD_TIMEOUT_MS + WORKTREE_PREPARE_BUDGET_MS,
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

/** Main cannot import pi-utils' Bun hash or its live worktree.base override. */
export async function stockWorktreeLocation(
	bridge: Pick<BridgeClient, "request">,
	primaryRoot: string,
): Promise<{ root: string; hash: string }> {
	const location = await bridge.request<{ root: string; hash: string }>("git.worktree_location", { primaryRoot });
	if (
		!location ||
		typeof location.root !== "string" ||
		!path.isAbsolute(location.root) ||
		typeof location.hash !== "string" ||
		!/^[0-9a-f]{7}$/.test(location.hash)
	) {
		throw new Error("omp returned an invalid worktree location");
	}
	return location;
}

/** The branch a worktree gets when the caller names it (`RpcCommand` `worktree_create.branch`), or undefined when malformed. */
export type WorktreeBranchSource = {
	name: string;
	mode: "new" | "local" | "remote";
	remote?: string;
	/** `new` only: the ref the branch starts at (default the folder's HEAD). */
	from?: string;
};

export function worktreeBranchSource(value: unknown): WorktreeBranchSource | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { name, mode, remote, from } = value as Record<string, unknown>;
	if (typeof name !== "string" || !name || (mode !== "new" && mode !== "local" && mode !== "remote")) return undefined;
	if (mode === "remote" && (typeof remote !== "string" || !remote || remote.startsWith("-"))) return undefined;
	if (from !== undefined && (typeof from !== "string" || !from || from.startsWith("-"))) return undefined;
	return {
		name,
		mode,
		...(typeof remote === "string" && remote ? { remote } : {}),
		...(typeof from === "string" ? { from } : {}),
	};
}

/** `git check-ref-format --branch`: the name is one git accepts for a branch (and not an option). */
async function validBranchName(cwd: string, name: string): Promise<boolean> {
	if (name.startsWith("-")) return false;
	return (await gitRaw(cwd, ["check-ref-format", "--branch", name])).code === 0;
}

/** Where a branch named by the caller is checked out: a new, a local or a remote-tracking one. */
async function addNamedWorktree(
	primary: string,
	baseCwd: string,
	target: string,
	source: WorktreeBranchSource,
): Promise<void> {
	const { name } = source;
	if (!(await validBranchName(primary, name))) {
		throw new LocalCommandError(`"${name}" is not a valid branch name.`, "invalid_name");
	}
	const exists = await branchExists(primary, name);
	if (source.mode === "new") {
		if (exists) throw new LocalCommandError(`The branch ${name} already exists.`, "worktree_create_failed");
		await git(baseCwd, ["branch", "--no-track", name, source.from ?? "HEAD"]);
		try {
			await git(primary, ["worktree", "add", target, name], { timeoutMs: WORKTREE_ADD_TIMEOUT_MS });
		} catch (error) {
			await gitRaw(primary, ["branch", "-D", name]).catch(() => undefined);
			throw error;
		}
		return;
	}
	if (source.mode === "local") {
		if (!exists) throw new LocalCommandError(`The branch ${name} does not exist.`, "worktree_create_failed");
		await git(primary, ["worktree", "add", target, name], { timeoutMs: WORKTREE_ADD_TIMEOUT_MS });
		return;
	}
	if (exists) throw new LocalCommandError(`The branch ${name} already exists locally.`, "worktree_create_failed");
	const upstream = `${source.remote}/${name}`;
	const tracked = await gitRaw(primary, ["show-ref", "--verify", "--quiet", `refs/remotes/${upstream}`]);
	if (tracked.code !== 0) {
		throw new LocalCommandError(`The remote branch ${upstream} does not exist.`, "worktree_create_failed");
	}
	await git(primary, ["worktree", "add", "--track", "-b", name, target, upstream], {
		timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
	});
}

export async function createWorktree(
	sessionCwd: string,
	input: {
		name: string;
		baseCwd?: string;
		baseRef?: "HEAD" | "default";
		branchPrefix?: string;
		branch?: WorktreeBranchSource;
	},
	bridge: Pick<BridgeClient, "request">,
): Promise<RpcWorktreeCreateResult> {
	const slug = worktreeSlug(input.name);
	if (!slug) {
		throw new LocalCommandError(
			`Invalid worktree name "${input.name}" — use 1-41 chars of [a-z0-9-], starting with a letter or digit.`,
			"invalid_name",
		);
	}
	const branchPrefix = input.branchPrefix === undefined ? undefined : worktreeBranchPrefix(input.branchPrefix);
	if (branchPrefix === null) {
		throw new LocalCommandError(`Invalid worktree branch prefix "${input.branchPrefix}".`, "invalid_name");
	}
	const baseCwd = input.baseCwd ?? sessionCwd;
	if (!(await repoRoot(baseCwd))) throw new LocalCommandError(`Not a git repository: ${baseCwd}`, "not_a_repo");
	const primary = await primaryRoot(baseCwd);
	const startPoint = input.baseRef === "default" ? ((await defaultBranchRef(primary)) ?? "HEAD") : "HEAD";
	const location = await stockWorktreeLocation(bridge, primary);

	const made = await withRepoLock(primary, async (): Promise<RpcWorktreeCreateResult> => {
		for (let suffix = 1; suffix <= MAX_SUFFIX; suffix++) {
			const candidate = guiWorktreeCandidate(slug, location.hash, suffix, location.root, branchPrefix);
			if (input.branch) {
				// The branch name is the caller's: only the folder takes a suffix.
				if (await pathTaken(candidate.path)) continue;
				try {
					await fs.mkdir(path.dirname(candidate.path), { recursive: true });
					await addNamedWorktree(primary, baseCwd, candidate.path, input.branch);
				} catch (error) {
					if (error instanceof LocalCommandError) throw error;
					throw new LocalCommandError(
						`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
						"worktree_create_failed",
					);
				}
				return { path: candidate.path, branch: input.branch.name, baseCwd: primary };
			}
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
	return { ...made, ...(await prepareWorktree(primary, made.path)) };
}

/**
 * What names a worktree made without a calling tab of this computer (an agent on another computer opening a
 * session here): the stock helper's `git.worktree_location` (stock-helper/worktrees.ts), the same stock
 * `worktree.base` and repo hash a tab's bridge answers `worktree_create` with, read from the repository's config.
 * No session of this computer needs to run.
 */
export const tablessWorktreeBridge: Pick<BridgeClient, "request"> = {
	request: <T>(method: string, params?: unknown) => stockHelperRequest<T>(method, params),
};

/**
 * Real path of `worktreePath` when it lies strictly inside `root` (the
 * directory every GUI and PR worktree is created under), else null. Both sides
 * are resolved first, so neither `..` segments nor a symlink inside the root
 * can reach a checkout elsewhere.
 */
export async function removableWorktreePath(worktreePath: string, root: string): Promise<string | null> {
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
export async function removeWorktree(
	input: { path: string; force?: boolean },
	bridge: Pick<BridgeClient, "request">,
	sessionCwd: string,
): Promise<{ removed: true }> {
	const { root } = await stockWorktreeLocation(bridge, path.resolve(sessionCwd));
	const worktreePath = await removableWorktreePath(input.path, root);
	if (!worktreePath) {
		throw new LocalCommandError(
			`Refusing to remove ${input.path || "(no path)"}: only registered linked worktrees under ${root} can be removed (check worktree.base).`,
			"worktree_outside_root",
		);
	}
	const checkoutRoot = await repoRoot(worktreePath).catch(() => null);
	if (!checkoutRoot || (await fs.realpath(checkoutRoot)) !== worktreePath) {
		throw new LocalCommandError(`Not a git checkout root: ${worktreePath}`, "not_a_worktree");
	}
	const primary = await primaryRoot(worktreePath);
	const registered = (await git(primary, ["worktree", "list", "--porcelain", "-z"]))
		.split("\0")
		.filter(field => field.startsWith("worktree "))
		.map(field => field.slice("worktree ".length));
	const linked = await Promise.all(registered.slice(1).map(file => fs.realpath(file).catch(() => null)));
	if ((await fs.realpath(primary)) === worktreePath || !linked.includes(worktreePath)) {
		throw new LocalCommandError(`Not a registered linked worktree: ${worktreePath}`, "not_a_worktree");
	}
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
