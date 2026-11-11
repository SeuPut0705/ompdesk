/**
 * `get_git_status`, `get_git_changes`, `get_git_fingerprint`, `get_git_diff`, the checkout root and the main checkout:
 * the read side of git runs in the core process (`native/ompdesk/crates/core/src/git`, methods `git.*`), and these are
 * its typed client. What stays here: the diff path's argument check (`isSafeRelativePath`, synchronous for `scm.ts`
 * too); `coreGit` (`exec.ts`) holds each read to the repository-lock step it is made in.
 */
import type { RpcGitChanges, RpcGitDiff, RpcGitFingerprint, RpcGitStatus } from "../../../shared/rpc-types";
import { coreGit } from "./exec";
import { isSafeRelativePath } from "./parse";

/** Worktree top-level for `cwd`, or null outside a repository. */
export function repoRoot(cwd: string): Promise<string | null> {
	return coreGit("git.repoRoot", { cwd }, 1);
}

/** Main checkout root shared by every linked worktree (`--git-common-dir`'s parent), as a native path (git prints `C:/…` on Windows). */
export function primaryRoot(cwd: string): Promise<string> {
	return coreGit("git.primaryRoot", { cwd }, 1);
}

export function getGitStatus(cwd: string): Promise<RpcGitStatus> {
	return coreGit("git.status", { cwd }, 1);
}

/**
 * A cheap stand-in for `getGitChanges` that the Changes panel polls: one status plus a stat of every listed path, and
 * the root asked of git only when the caller does not pass the one its last full read reported (or passes one that
 * does not hold `cwd`). It changes whenever the full answer may have; its value compares only with this app's own.
 */
export function getGitFingerprint(cwd: string, knownRoot?: string): Promise<RpcGitFingerprint> {
	return coreGit("git.fingerprint", { cwd, root: knownRoot }, 1);
}

export function getGitChanges(cwd: string): Promise<RpcGitChanges> {
	return coreGit("git.changes", { cwd }, 2);
}

/** Read one authorized changed path; never follow a symlink out of the checkout. */
export async function getGitDiff(cwd: string, filePath: string): Promise<RpcGitDiff> {
	if (!isSafeRelativePath(filePath)) throw new Error("Invalid repository-relative path");
	return coreGit("git.diff", { cwd, path: filePath }, 5);
}
