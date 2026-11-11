/**
 * `worktree_create` / `worktree_remove` (port of fork rpc-worktree.ts). The gits and their rules (base and branch
 * checks, `worktree add` and its branch rollback, the checks before a removal, the removal) run in the core process
 * (`native/ompdesk/crates/core/src/git/worktree.rs`); this is their typed client, which keeps what main owns: the
 * names (stock's canonical worktree base and repo hash through the bridge), the folder checks and `mkdir` under the
 * repository lock on the fenced files (`fenced-fs.ts`), the removal guard on real paths and the lock itself.
 * Collisions suffix `-2..-100` on path and branch. Removal keeps the branch and
 * requires a linked checkout registered by git under the canonical root.
 * Kept over stock createSessionWorktree: GUI names/baseRef differ and never carry
 * uncommitted changes. Removal deliberately retains branches; session exit safety
 * still runs in main after omp has gone, unlike stock removeExitWorktrees.
 */

import * as path from "node:path";
import type { RpcWorktreeCreateResult } from "../../../shared/rpc-types";
import { worktreeBranchPrefix } from "../../../shared/worktree-branch";
import { CoreError } from "../../core/process";
import { fs } from "../../fenced-fs";
import { stockHelperRequest } from "../../stock-helper";
import { type BridgeClient, LocalCommandError } from "../types";
import { coreGit, DEFAULT_TIMEOUT_MS, withRepoLock } from "./exec";
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

/** The codes the core refuses a worktree step with, which the page gets as the command's `code`. */
const REFUSALS = new Set([
	"not_a_repo",
	"invalid_base",
	"invalid_name",
	"worktree_create_failed",
	"not_a_worktree",
	"worktree_dirty",
	"worktree_remove_failed",
]);

/** One worktree request to the core (`rounds`, `slowMs`: see `coreGit`); its refusals keep their code. */
export async function worktreeGit<T>(method: string, params: object, rounds: number, slowMs?: number): Promise<T> {
	try {
		return await coreGit<T>(method, params, rounds, slowMs);
	} catch (error) {
		if (error instanceof CoreError && REFUSALS.has(error.code))
			throw new LocalCommandError(error.message, error.code);
		throw error;
	}
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

export async function createWorktree(
	sessionCwd: string,
	input: {
		name: string;
		baseCwd?: string;
		baseRef?: string;
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
	// The repository, its main checkout, and the commit a new branch starts at (`HEAD`, `default`, or a ref it has).
	const { primary, startPoint } = await worktreeGit<{ primary: string; startPoint: string }>(
		"git.worktreePlan",
		{ cwd: baseCwd, baseRef: input.baseRef },
		3,
	);
	// The main checkout as the caller spells it when it is that directory: git answers with the long form of a Windows
	// 8.3 path (C:\Users\RUNNER~1\…), and the caller's tabs and sessions compare against the form it gave.
	const realOf = (dir: string) =>
		fs.realpath(dir).then(real => (process.platform === "win32" ? real.toLowerCase() : real));
	const mainCheckout =
		(await realOf(baseCwd).catch(() => null)) === (await realOf(primary).catch(() => undefined))
			? path.resolve(baseCwd)
			: primary;
	const location = await stockWorktreeLocation(bridge, primary);

	const made = await withRepoLock(primary, async (): Promise<RpcWorktreeCreateResult> => {
		for (let suffix = 1; suffix <= MAX_SUFFIX; suffix++) {
			const candidate = guiWorktreeCandidate(slug, location.hash, suffix, location.root, branchPrefix);
			// A half-created dir (no .git yet) still makes `git worktree add` fail with "exists".
			if (await pathTaken(candidate.path)) continue;
			const add = { primary, baseCwd, path: candidate.path, addTimeoutMs: WORKTREE_ADD_TIMEOUT_MS };
			try {
				await fs.mkdir(path.dirname(candidate.path), { recursive: true });
				if (input.branch) {
					// The branch name is the caller's: only the folder takes a suffix.
					await worktreeGit("git.worktreeAddNamed", { ...add, source: input.branch }, 4, WORKTREE_ADD_TIMEOUT_MS);
					return { path: candidate.path, branch: input.branch.name, baseCwd: mainCheckout };
				}
				// A taken branch name moves on to the next suffix; a failed add has rolled its branch back.
				const { taken } = await worktreeGit<{ taken: boolean }>(
					"git.worktreeAdd",
					{ ...add, branch: candidate.branch, startPoint },
					3,
					WORKTREE_ADD_TIMEOUT_MS,
				);
				if (!taken) return { path: candidate.path, branch: candidate.branch, baseCwd: mainCheckout };
			} catch (error) {
				if (error instanceof LocalCommandError) throw error;
				throw new LocalCommandError(
					`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`,
					"worktree_create_failed",
				);
			}
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
	const { primary } = await worktreeGit<{ primary: string }>(
		"git.worktreeRemoval",
		{ path: worktreePath, force: input.force === true },
		4,
	);
	return withRepoLock(primary, () =>
		worktreeGit<{ removed: true }>(
			"git.worktreeRemove",
			{ primary, path: worktreePath, timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS },
			1,
			WORKTREE_REMOVE_TIMEOUT_MS,
		),
	);
}
