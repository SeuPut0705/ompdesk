/**
 * `git` / `gh` subprocess runner for the GUI-side git commands. No shell, argv
 * arrays only (Windows-safe); binaries resolve against the login-shell PATH
 * (same merge as the omp runtime) because a Finder-launched app inherits
 * launchd's bare PATH, where Homebrew's `gh` is missing.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withoutGitSelectors } from "../../../shared/git-env";
import { ChainBusyError, currentStepSignal, SerialChain, trackEffect } from "../../serial-chain";
import { brewBinDirs, spawnPath } from "../../shell-env";
import { findOnPath } from "../../spawn";
import { LocalCommandError } from "../types";

/** Timeout for a `git`/`gh` call that names none; commands' answer budgets count in it. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Hard cap on captured stdout; matches gh's 8 MiB output ceiling. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** How long a process that was asked to end may ignore it before it is killed outright. */
const KILL_GRACE_MS = 2_000;

export interface ExecResult {
	code: number;
	stdout: Buffer;
	stderr: string;
	/** stdout hit `maxBytes` and the process was killed. */
	truncated: boolean;
}

export interface ExecOptions {
	cwd: string;
	timeoutMs?: number;
	maxBytes?: number;
	env?: Record<string, string>;
	/** Bytes written to the process's stdin; without it stdin is closed. */
	input?: Buffer;
}

const binCache = new Map<string, Promise<string | null>>();

// The spawn PATH is read on every lookup, never kept here: setup changes it while the app runs (refreshPath
// appends the managed tools dirs and drops the login-shell probe after an install), and a copy taken at the
// first git call hid a freshly installed gh until relaunch. spawnPath shares the probe it caches.

// Homebrew's prefixes are looked in too when its bin dir is not on the login-shell PATH (a shell that never
// runs `brew shellenv`, a PATH an rc file rebuilds): a gh or git installed by brew is still the user's.

/** Absolute path to `git`/`gh`, or null when not installed. */
export function resolveBin(name: "git" | "gh"): Promise<string | null> {
	let pending = binCache.get(name);
	if (!pending) {
		const platform = process.platform;
		// `<name>.exe`, then the bare name, on Windows.
		const names = platform === "win32" ? [`${name}.exe`, name] : [name];
		pending = spawnPath().then(pathEnv =>
			findOnPath(names, pathEnv, platform, platform === "darwin" ? brewBinDirs().map(dir => join(dir, name)) : []),
		);
		binCache.set(name, pending);
		// A missing binary is re-probed next call (the user may install it).
		void pending.then(bin => {
			if (!bin && binCache.get(name) === pending) binCache.delete(name);
		});
	}
	return pending;
}

/** The git `/usr/bin/git` forwards to from developer dir `dir` (`DEVELOPER_DIR` or `xcode-select -p`), when it is there. */
export function developerGit(dir: string | null): string | null {
	const git = dir?.trim() ? join(dir.trim(), "usr", "bin", "git") : null;
	return git && existsSync(git) ? git : null;
}

let trampolineTarget: Promise<string> | null = null;

/**
 * The git GUI git calls run. macOS's `/usr/bin/git` is xcrun's trampoline: every run looks the active developer
 * dir up before it starts that dir's `usr/bin/git` (measured on an M-series Mac: about 3.4 ms of CPU and 4.5 ms
 * of wall time per call, more than a `git rev-parse` itself and half again a `git status` of 500 changed files).
 * Calling the git it forwards to runs the same binary without the lookup. With no developer dir (where the
 * trampoline offers the Command Line Tools install), `/usr/bin/git` stays.
 */
async function gitBin(): Promise<string | null> {
	const found = await resolveBin("git");
	if (process.platform !== "darwin" || found !== "/usr/bin/git") return found;
	trampolineTarget ??= (async () => {
		if (process.env.DEVELOPER_DIR) return developerGit(process.env.DEVELOPER_DIR) ?? found;
		const { promise, resolve } = Promise.withResolvers<string | null>();
		execFile("/usr/bin/xcode-select", ["-p"], { timeout: 5_000 }, (error, stdout) => resolve(error ? null : stdout));
		return developerGit(await promise) ?? found;
	})();
	return trampolineTarget;
}

/** Ask a process to end, and end it for good when it ignores the request. */
function endProcess(child: ChildProcess): void {
	child.kill();
	setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
}

/** Spawn `bin args`; never rejects on non-zero exit, rejects on spawn failure / timeout. */
export async function execBin(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
	// A call made in a chain step that was stopped (the repository lock's bound) never starts, and ends once it is.
	const hold = currentStepSignal();
	if (hold?.aborted) throw hold.reason;
	const pathEnv = await spawnPath();
	if (hold?.aborted) throw hold.reason;
	const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
	const child = spawn(bin, args, {
		cwd: opts.cwd,
		// A read-only `git status` must not take `.git/index.lock` to refresh the index: the agent's own git would fail on it.
		// Ambient repository selectors (an OMPdesk started from a hook or `git bisect run`) are dropped, so git works on the
		// repository `cwd` is in; a selector the caller means (disk care's scratch GIT_INDEX_FILE) comes in `opts.env`.
		env: { ...withoutGitSelectors(process.env), PATH: pathEnv, GIT_OPTIONAL_LOCKS: "0", ...opts.env },
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	// The repository lock waits for this child to exit when its holder is stopped: a git still writing must not overlap
	// the next holder.
	const exited = Promise.withResolvers<void>();
	child.once("close", () => exited.resolve());
	child.once("error", () => exited.resolve());
	trackEffect(`${bin} ${args[0] ?? ""}`.trim(), exited.promise);
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const chunks: Buffer[] = [];
	let size = 0;
	let truncated = false;
	let stderr = "";
	const timer = setTimeout(() => {
		endProcess(child);
		reject(new Error(`${args[0] ?? bin} timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	const stop = () => {
		clearTimeout(timer);
		endProcess(child);
		reject(hold?.reason);
	};
	hold?.addEventListener("abort", stop, { once: true });
	child.stdout.on("data", (chunk: Buffer) => {
		if (truncated) return;
		if (size + chunk.length > maxBytes) {
			chunks.push(chunk.subarray(0, maxBytes - size));
			size = maxBytes;
			truncated = true;
			endProcess(child);
			return;
		}
		chunks.push(chunk);
		size += chunk.length;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		if (stderr.length < 64 * 1024) stderr += chunk;
	});
	// A process that exits before reading its input (a failing git) closes the pipe: that is its exit code's news, not ours.
	child.stdin.on("error", () => {});
	child.stdin.end(opts.input);
	child.on("error", err => {
		clearTimeout(timer);
		hold?.removeEventListener("abort", stop);
		reject(err);
	});
	child.on("close", code => {
		clearTimeout(timer);
		hold?.removeEventListener("abort", stop);
		resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr, truncated });
	});
	return promise;
}

export class GitCommandError extends Error {
	constructor(
		readonly args: string[],
		readonly result: ExecResult,
	) {
		super(result.stderr.trim() || `git ${args[0] ?? ""} exited with code ${result.code}`);
		this.name = "GitCommandError";
	}
}

/** Run git; resolves stdout text, rejects on non-zero exit. */
export async function git(cwd: string, args: string[], opts: Omit<ExecOptions, "cwd"> = {}): Promise<string> {
	const result = await gitRaw(cwd, args, opts);
	if (result.code !== 0) throw new GitCommandError(args, result);
	return result.stdout.toString("utf8");
}

/** Run git without throwing on exit code (still throws when git is missing). */
export async function gitRaw(cwd: string, args: string[], opts: Omit<ExecOptions, "cwd"> = {}): Promise<ExecResult> {
	const bin = await gitBin();
	if (!bin) throw new Error("git is not installed or not on PATH");
	// Never page, never prompt for credentials from a headless GUI call.
	return execBin(bin, ["-c", "core.quotepath=false", "-c", "color.ui=false", ...args], {
		cwd,
		...opts,
		env: { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", ...opts.env },
	});
}

/** Run gh; resolves stdout text, rejects with gh's stderr on non-zero exit. */
export async function gh(
	cwd: string,
	bin: string,
	args: string[],
	opts: Omit<ExecOptions, "cwd"> = {},
): Promise<string> {
	const result = await execBin(bin, args, {
		cwd,
		...opts,
		env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", ...opts.env },
	});
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `gh ${args.slice(0, 2).join(" ")} exited with code ${result.code}`);
	}
	if (result.truncated) throw new Error(`gh ${args.slice(0, 2).join(" ")} output exceeded the size cap`);
	return result.stdout.toString("utf8");
}

/** Run gh (or git) with gh's non-interactive env to completion as text; never rejects on a non-zero exit. */
export async function ghText(
	cwd: string,
	bin: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const result = await execBin(bin, args, {
		cwd,
		timeoutMs: 30_000,
		env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
	});
	return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
}

/**
 * The longest one holder keeps a repository's lock. The longest legitimate holder is `worktree_create`'s answer
 * budget (six git steps, `git worktree add`, the seed and setup hook: 16 min); a holder past this is hung.
 */
export const REPO_LOCK_HOLD_MS = 20 * 60_000;

const repoLocks = new Map<string, SerialChain>();

/**
 * Per-repository mutex for worktree/branch/config mutations (git uses O_EXCL lock files with no waiter).
 * A holder that runs past `REPO_LOCK_HOLD_MS` fails with a `StepStalledError`, the git processes it started end and
 * it starts no more (nor does any file call: `fenced-fs`). The repository's next mutation runs once the git process
 * and the file calls the stopped holder already had running ended; while they still run a minute after the stop, every
 * mutation fails at once with a `repo_busy` error naming them (reads take no lock and are not held).
 */
export function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
	let chain = repoLocks.get(root);
	if (!chain) {
		chain = new SerialChain({ name: "repository lock", maxStepMs: REPO_LOCK_HOLD_MS });
		repoLocks.set(root, chain);
	}
	const held = chain;
	const run = held
		.run(() => fn(), root)
		.catch((error: unknown) => {
			// Refused, not run: a stopped holder's git or file call still runs on this repository.
			if (error instanceof ChainBusyError) throw new LocalCommandError(error.message, "repo_busy");
			throw error;
		});
	const release = () => {
		if (held.pending === 0 && repoLocks.get(root) === held) repoLocks.delete(root);
	};
	// A chain that a stopped holder still holds stays registered until that ended: the next holder checks it.
	const retire = () => {
		if (!held.held) release();
		else void held.released().then(release);
	};
	run.then(retire, retire);
	return run;
}
