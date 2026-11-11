/**
 * `get_git_status`, `get_git_changes`, `get_git_fingerprint`, `get_git_diff` and the checkout root: the read side of
 * git runs in the core process (`native/ompdesk/crates/core/src/git`, methods `git.*`), and these are its typed client.
 * What stays here: how git runs (`gitRunner`, the rules the write side's own runner follows), the diff path's argument
 * check (`isSafeRelativePath`, synchronous for `scm.ts` too), the repository lock's fence, and `primaryRoot`, which only
 * the write side uses and which moves with it.
 */
import * as path from "node:path";
import type { RpcGitChanges, RpcGitDiff, RpcGitFingerprint, RpcGitHead, RpcGitStatus } from "../../../shared/rpc-types";
import { core } from "../../core/process";
import { currentStepSignal, trackEffect } from "../../serial-chain";
import { git, gitRunner } from "./exec";
import { isSafeRelativePath } from "./parse";

/** Room past the gits' own timeouts for a read's disk work (the diff's stat, real paths and file read). */
const DISK_SLACK_MS = 5_000;

/**
 * One read in the core, held to the repository-lock step it is made in as a git `execBin` spawns is: it never starts in
 * a stopped step, fails at once when its step is stopped, and the lock's next holder waits for its answer. `rounds` is
 * how many gits the read runs one after another; the core times out each, so the call waits that long.
 */
async function read<T>(method: string, params: object, rounds: number): Promise<T> {
	const hold = currentStepSignal();
	if (hold?.aborted) throw hold.reason;
	const runner = await gitRunner();
	if (hold?.aborted) throw hold.reason;
	const answer = trackEffect(
		method,
		core().call<T>(method, { ...params, git: runner }, { timeoutMs: rounds * runner.timeoutMs + DISK_SLACK_MS }),
	);
	if (!hold) return (await answer).result;
	const stopped = Promise.withResolvers<never>();
	const stop = () => stopped.reject(hold.reason);
	hold.addEventListener("abort", stop, { once: true });
	try {
		return (await Promise.race([answer, stopped.promise])).result;
	} finally {
		hold.removeEventListener("abort", stop);
	}
}

/** Worktree top-level for `cwd`, or null outside a repository. */
export function repoRoot(cwd: string): Promise<string | null> {
	return read("git.repoRoot", { cwd }, 1);
}

/** Main checkout root shared by every linked worktree (`--git-common-dir`'s parent), as a native path (git prints `C:/…` on Windows). */
export async function primaryRoot(cwd: string): Promise<string> {
	const common = path.resolve((await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
	return path.basename(common) === ".git" ? path.dirname(common) : common;
}

export function getGitStatus(cwd: string): Promise<RpcGitStatus> {
	return read("git.status", { cwd }, 1);
}

/** Branch, upstream, ahead/behind, stopped operation and stash count of the checkout at `root`. */
export function getGitHead(root: string): Promise<RpcGitHead> {
	return read("git.head", { cwd: root }, 1);
}

/**
 * A cheap stand-in for `getGitChanges` that the Changes panel polls: one status plus a stat of every listed path, and
 * the root asked of git only when the caller does not pass the one its last full read reported (or passes one that
 * does not hold `cwd`). It changes whenever the full answer may have; its value compares only with this app's own.
 */
export function getGitFingerprint(cwd: string, knownRoot?: string): Promise<RpcGitFingerprint> {
	return read("git.fingerprint", { cwd, root: knownRoot }, 1);
}

export function getGitChanges(cwd: string): Promise<RpcGitChanges> {
	return read("git.changes", { cwd }, 2);
}

/** Read one authorized changed path; never follow a symlink out of the checkout. */
export async function getGitDiff(cwd: string, filePath: string): Promise<RpcGitDiff> {
	if (!isSafeRelativePath(filePath)) throw new Error("Invalid repository-relative path");
	return read("git.diff", { cwd, path: filePath }, 5);
}
