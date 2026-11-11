/**
 * Source control for the Changes panel: stage, commit, push/pull/fetch,
 * stash, branches and history over the git CLI on the session checkout.
 * Each command's gits run in the core process as one request (`git.*`,
 * native/ompdesk/crates/core/src/git/scm.rs); this file is its typed client.
 * What stays here: the checkout root and the repository lock around every
 * mutation, the check of what the page sent (paths, names, shas, an empty
 * message, a reset mode), the removal of the untracked files a discard names
 * (fenced to the lock, `fenced-fs`), and the commit message, which stock
 * `omp commit --dry-run` writes (stock's conventional-commit pipeline; it
 * never commits on a dry run).
 *
 * Failures map to typed codes: not_a_repo / invalid_name / invalid_path /
 * git_failed / push_rejected / no_remote / detached_head / nothing_staged /
 * commit_message_failed / branch_checked_out / dirty_worktree / commit_pushed.
 */

import * as path from "node:path";
import type {
	RpcGitBranch,
	RpcGitCommitDetail,
	RpcGitDiff,
	RpcGitLog,
	RpcGitMutationResult,
	RpcGitRemoteResult,
} from "../../../shared/rpc-types";
import { CoreError } from "../../core/process";
import { fs } from "../../fenced-fs";
import type { OmpRuntime } from "../types";
import { LocalCommandError } from "../types";
import { repoRoot } from "./changes";
import { coreGit, withRepoLock } from "./exec";
import { isSafeRelativePath, isValidRefName } from "./parse";

/** Hooks (pre-commit, commit-msg) and network round trips get longer than a status read. */
const COMMIT_TIMEOUT_MS = 300_000;
const REMOTE_TIMEOUT_MS = 300_000;
/** Stock `omp commit` reads the staged diff and asks the model (smol role first). */
const MESSAGE_TIMEOUT_MS = 180_000;

/**
 * Longest each command runs before main answers. The renderer's RPC timeouts
 * (shared/rpc-client.ts) must not be shorter, or it reports a failure while
 * the commit or push still lands.
 */
export const SCM_COMMAND_BUDGETS_MS = {
	git_commit: COMMIT_TIMEOUT_MS + 60_000,
	git_commit_message: MESSAGE_TIMEOUT_MS + 60_000,
	git_remote: REMOTE_TIMEOUT_MS + 60_000,
	git_branch: COMMIT_TIMEOUT_MS + 60_000,
	git_history_action: COMMIT_TIMEOUT_MS + 60_000,
	git_operation: COMMIT_TIMEOUT_MS + 60_000,
} as const;

/** The codes the core refuses with, which the page gets as the command's `code`; git's own failures carry none. */
const REFUSALS = new Set([
	"git_failed",
	"invalid_name",
	"nothing_staged",
	"no_remote",
	"detached_head",
	"push_rejected",
	"branch_checked_out",
	"dirty_worktree",
	"commit_pushed",
]);

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One source-control request to the core (`rounds`, `slowMs`: see `coreGit`); its refusals keep their code. */
async function scmGit<T>(method: string, params: object, rounds: number, slowMs?: number): Promise<T> {
	try {
		return await coreGit<T>(method, params, rounds, slowMs);
	} catch (error) {
		if (error instanceof CoreError && REFUSALS.has(error.code))
			throw new LocalCommandError(error.message, error.code);
		throw error;
	}
}

async function requireRoot(cwd: string): Promise<string> {
	const root = await repoRoot(cwd);
	if (!root) throw new LocalCommandError(`Not a git repository: ${cwd}`, "not_a_repo");
	return root;
}

/** Run a mutation under the repository lock; git's own failure text becomes a `git_failed` error. */
async function mutate<T>(cwd: string, fn: (root: string) => Promise<T>): Promise<T> {
	const root = await requireRoot(cwd);
	try {
		return await withRepoLock(root, () => fn(root));
	} catch (error) {
		if (error instanceof LocalCommandError) throw error;
		throw new LocalCommandError(errorText(error), "git_failed");
	}
}

function checkPaths(paths: unknown): string[] {
	if (!Array.isArray(paths) || paths.length === 0 || !paths.every(p => typeof p === "string" && isSafeRelativePath(p)))
		throw new LocalCommandError("Invalid repository-relative path", "invalid_path");
	return paths as string[];
}

function checkRef(name: string): string {
	if (!isValidRefName(name)) throw new LocalCommandError(`Invalid branch or tag name: ${name}`, "invalid_name");
	return name;
}

function checkSha(sha: string): string {
	if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new LocalCommandError(`Invalid commit: ${sha}`, "invalid_name");
	return sha;
}

export async function stage(cwd: string, paths: string[] | "all"): Promise<void> {
	await mutate(cwd, async root => {
		await scmGit("git.stage", { root, paths: paths === "all" ? null : checkPaths(paths) }, 1);
	});
}

export async function unstage(cwd: string, paths: string[] | "all"): Promise<void> {
	await mutate(cwd, async root => {
		await scmGit("git.unstage", { root, paths: paths === "all" ? null : checkPaths(paths) }, 2);
	});
}

/** Back to HEAD in index and worktree; untracked or newly added paths are removed. */
export async function discard(cwd: string, paths: string[]): Promise<void> {
	await mutate(cwd, async root => {
		const { fresh } = await scmGit<{ fresh: string[] }>("git.discard", { root, paths: checkPaths(paths) }, 4);
		if (fresh.length === 0) return;
		const realRoot = await fs.realpath(root);
		for (const file of fresh) {
			const target = path.join(realRoot, file);
			if (path.relative(realRoot, target).startsWith("..")) continue;
			await fs.rm(target, { force: true, recursive: true });
		}
	});
}

export async function commit(cwd: string, input: { message: string; amend?: boolean }): Promise<{ sha: string }> {
	const message = input.message.trim();
	if (!message) throw new LocalCommandError("A commit needs a message", "invalid_name");
	return mutate(cwd, root =>
		scmGit(
			"git.commit",
			{ root, message, amend: input.amend === true, slowMs: COMMIT_TIMEOUT_MS },
			3,
			COMMIT_TIMEOUT_MS,
		),
	);
}

export async function lastCommitMessage(cwd: string): Promise<{ message: string }> {
	const root = await requireRoot(cwd);
	return scmGit("git.lastCommitMessage", { root }, 2);
}

/** Undo the last commit and keep its changes staged (`reset --soft HEAD~1`). */
export async function undoCommit(cwd: string): Promise<void> {
	await mutate(cwd, async root => {
		await scmGit("git.undoCommit", { root }, 2);
	});
}

/** The message stock `omp commit --dry-run` prints after "Generated commit message:". */
export function parseGeneratedMessage(stdout: string): string | null {
	const marker = "Generated commit message:";
	const at = stdout.lastIndexOf(marker);
	if (at < 0) return null;
	const message = stdout.slice(at + marker.length).trim();
	return message || null;
}

/** A commit message for the staged changes from stock's commit pipeline; never stages or commits. */
export async function commitMessage(cwd: string, omp: OmpRuntime): Promise<{ message: string; warning?: string }> {
	const root = await requireRoot(cwd);
	// Stock stages everything when the index is empty; the panel only asks with something staged.
	if (!(await scmGit<{ staged: boolean }>("git.staged", { root }, 1)).staged)
		throw new LocalCommandError("Stage changes first", "nothing_staged");
	let output: { code: number; stdout: string; stderr: string };
	try {
		output = await omp.run(["commit", "--dry-run", "--legacy", "--no-changelog"], {
			cwd: root,
			timeoutMs: MESSAGE_TIMEOUT_MS,
		});
	} catch (error) {
		throw new LocalCommandError(`omp commit failed: ${errorText(error)}`, "commit_message_failed");
	}
	const message = output.code === 0 ? parseGeneratedMessage(output.stdout) : null;
	if (!message) {
		const detail = (output.stderr || output.stdout).trim().slice(-400);
		throw new LocalCommandError(`omp commit gave no message${detail ? `: ${detail}` : ""}`, "commit_message_failed");
	}
	const warning = /requires manual correction: (.+)/.exec(output.stderr)?.[1]?.trim();
	return warning ? { message, warning } : { message };
}

export async function remote(cwd: string, action: "push" | "pull" | "fetch"): Promise<RpcGitRemoteResult> {
	return mutate(cwd, root => scmGit("git.remote", { root, action, slowMs: REMOTE_TIMEOUT_MS }, 3, REMOTE_TIMEOUT_MS));
}

export async function stash(cwd: string, action: "push" | "pop", message?: string): Promise<RpcGitMutationResult> {
	return mutate(cwd, root =>
		scmGit(
			"git.stash",
			{ root, action, message: action === "push" ? message?.trim() || null : null, slowMs: COMMIT_TIMEOUT_MS },
			1,
			COMMIT_TIMEOUT_MS,
		),
	);
}

export async function operation(cwd: string, action: "continue" | "abort"): Promise<RpcGitMutationResult> {
	return mutate(cwd, root =>
		scmGit("git.operation", { root, action, slowMs: COMMIT_TIMEOUT_MS }, 3, COMMIT_TIMEOUT_MS),
	);
}

export async function branches(cwd: string): Promise<RpcGitBranch[]> {
	const root = await requireRoot(cwd);
	return scmGit("git.branches", { root }, 1);
}

export async function branch(
	cwd: string,
	input: {
		action: "switch" | "create" | "rename" | "delete" | "merge";
		name: string;
		newName?: string;
		base?: string;
		force?: boolean;
	},
): Promise<RpcGitMutationResult> {
	const name = checkRef(input.name);
	return mutate(cwd, async root => {
		const base = input.action === "create" && input.base ? checkRef(input.base) : null;
		const newName = input.action === "rename" ? checkRef(input.newName ?? "") : "";
		return scmGit<RpcGitMutationResult>(
			"git.branch",
			{ root, action: input.action, name, newName, base, force: input.force === true, slowMs: COMMIT_TIMEOUT_MS },
			2,
			COMMIT_TIMEOUT_MS,
		);
	});
}

export async function log(cwd: string, input: { limit?: number; skip?: number; query?: string }): Promise<RpcGitLog> {
	const root = await requireRoot(cwd);
	return scmGit("git.log", { root, limit: input.limit, skip: input.skip, query: input.query?.trim() || null }, 4);
}

export async function commitDetail(cwd: string, sha: string): Promise<RpcGitCommitDetail> {
	const root = await requireRoot(cwd);
	return scmGit("git.commitDetail", { root, sha: checkSha(sha) }, 1);
}

export async function commitDiff(cwd: string, sha: string, filePath: string): Promise<RpcGitDiff> {
	const root = await requireRoot(cwd);
	const id = checkSha(sha);
	if (!isSafeRelativePath(filePath)) throw new LocalCommandError("Invalid repository-relative path", "invalid_path");
	return scmGit("git.commitDiff", { root, sha: id, path: filePath }, 1);
}

/**
 * `move_earlier`/`move_later` (C77) swap `sha` with its parent or with its child on HEAD's line through an interactive
 * rebase the core writes the todo of; only a clean, merge-free, unpushed stretch of the current line is rewritten, and
 * a conflict stops the rebase for continue/abort like any other.
 */
export async function historyAction(
	cwd: string,
	input: {
		action:
			| "checkout"
			| "branch"
			| "cherry_pick"
			| "revert"
			| "reset"
			| "tag"
			| "delete_tag"
			| "move_earlier"
			| "move_later";
		sha: string;
		mode?: "soft" | "mixed" | "hard";
		name?: string;
	},
): Promise<RpcGitMutationResult> {
	const sha = checkSha(input.sha);
	return mutate(cwd, async root => {
		let mode = "";
		if (input.action === "reset") {
			mode = input.mode ?? "mixed";
			if (!["soft", "mixed", "hard"].includes(mode))
				throw new LocalCommandError(`Unknown reset mode: ${mode}`, "invalid_name");
		}
		const named = input.action === "branch" || input.action === "tag" || input.action === "delete_tag";
		const name = named ? checkRef(input.name ?? "") : "";
		// A move runs nine gits before its rebase.
		return scmGit<RpcGitMutationResult>(
			"git.historyAction",
			{ root, action: input.action, sha, mode, name, slowMs: COMMIT_TIMEOUT_MS },
			9,
			COMMIT_TIMEOUT_MS,
		);
	});
}
