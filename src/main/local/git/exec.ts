/**
 * `git` / `gh` subprocess runner for the GUI-side git commands. No shell, argv
 * arrays only (Windows-safe); binaries resolve against the login-shell PATH
 * (same merge as the omp runtime) because a Finder-launched app inherits
 * launchd's bare PATH, where Homebrew's `gh` is missing.
 *
 * The Changes panel's git (`changes.ts`, `scm.ts`), every gh run (`pr.ts`, `github.ts` and the clients `gh`, `ghText`
 * below) and disk care's gits and disk work (`src/main/disk/`) run in the core process
 * (`native/ompdesk/crates/core/src/{git,gh,disk}`): `gitRunner` and `ghRunner` hand it this file's rules (binary,
 * environment, timeout, output cap), so both runners follow one set, and `coreGit`, `coreGh` and `coreHeld` hold each
 * request to the repository-lock step it is made in as `execBin` holds a git.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withoutGitSelectors } from "../../../shared/git-env";
import { type CoreAnswer, core } from "../../core/process";
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

/** What every spawn here gets: ambient repository selectors dropped, the login shell's PATH, no optional git locks. */
async function spawnEnv(env: Record<string, string> | undefined): Promise<NodeJS.ProcessEnv> {
	// A read-only `git status` must not take `.git/index.lock` to refresh the index: the agent's own git would fail on it.
	// Ambient repository selectors (an OMPdesk started from a hook or `git bisect run`) are dropped, so git works on the
	// repository `cwd` is in; a selector the caller means (disk care's scratch GIT_INDEX_FILE) comes in `env`.
	return { ...withoutGitSelectors(process.env), PATH: await spawnPath(), GIT_OPTIONAL_LOCKS: "0", ...env };
}

/** Never page, never prompt for credentials from a headless GUI call; paths unquoted, no colour. */
const GIT_ARGS = ["-c", "core.quotepath=false", "-c", "color.ui=false"];
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" };

/** How a git or a gh runs, as the core process is told it: the core spawns `bin` with `args` first and exactly `env`. */
export interface CoreRunner {
	bin: string;
	args: string[];
	env: Record<string, string>;
	timeoutMs: number;
	maxBytes: number;
}

/** `spawnEnv` with `extra` over it, as the plain strings a request carries. */
async function runnerEnv(extra: Record<string, string>): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(await spawnEnv(extra))) if (value !== undefined) env[name] = value;
	return env;
}

/** This process's git rules for a git the core runs, read now (the PATH and the environment can change while the app runs). */
export async function gitRunner(): Promise<CoreRunner> {
	const bin = await gitBin();
	if (!bin) throw new Error("git is not installed or not on PATH");
	return {
		bin,
		args: GIT_ARGS,
		env: await runnerEnv(GIT_ENV),
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxBytes: DEFAULT_MAX_BYTES,
	};
}

/** Never prompt, never check for a newer gh, no colour. */
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

/** This process's rules for the gh (or, for the sign-in's git calls, the git) at `bin` that the core runs, read now. */
async function ghRunner(bin: string): Promise<CoreRunner> {
	return { bin, args: [], env: await runnerEnv(GH_ENV), timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: DEFAULT_MAX_BYTES };
}

/** Room past a request's git timeouts for its disk work, the core round trip and the end of a git that ran past one. */
const CORE_SLACK_MS = KILL_GRACE_MS + 5_000;

/**
 * A request to the core whose processes run with this process's rules (`params` builds it, runners included), held to
 * the repository-lock step it is made in as an `execBin` process is: it never starts in a stopped step; when its step
 * is stopped it fails at once with the stop, the core ends the process it runs (asked, then killed `KILL_GRACE_MS`
 * later) and starts no other, and the lock's next holder waits until the core is done with the request, which is once
 * every process it started exited. `timeoutMs` is how long its processes may take in all; the call waits that plus
 * `CORE_SLACK_MS`.
 */
async function heldRequest<T>(method: string, params: () => Promise<object>, timeoutMs: number): Promise<T> {
	return (await heldAnswer<T>(method, params, timeoutMs)).result;
}

/** `heldRequest` with the answer's `bin` tail. */
async function heldAnswer<T>(method: string, params: () => Promise<object>, timeoutMs: number): Promise<CoreAnswer<T>> {
	const hold = currentStepSignal();
	if (hold?.aborted) throw hold.reason;
	const request = await params();
	if (hold?.aborted) throw hold.reason;
	const ended = Promise.withResolvers<void>();
	void trackEffect(method, ended.promise);
	const answer = core().call<T>(method, request, {
		timeoutMs: timeoutMs + CORE_SLACK_MS,
		signal: hold,
		onEnded: ended.resolve,
	});
	if (!hold) return answer;
	const stopped = Promise.withResolvers<never>();
	const stop = () => stopped.reject(hold.reason);
	hold.addEventListener("abort", stop, { once: true });
	try {
		return await Promise.race([answer, stopped.promise]);
	} finally {
		hold.removeEventListener("abort", stop);
	}
}

/**
 * A git request to the core (`gitRunner`), held as `heldRequest` says. `rounds` is how many gits it runs one after
 * another at the default timeout, `slowMs` the timeout of its slow one (a hook, the network, a merge); the call waits
 * for both.
 */
export async function coreGit<T>(method: string, params: object, rounds: number, slowMs = 0): Promise<T> {
	return (await coreGitAnswer<T>(method, params, rounds, slowMs)).result;
}

/** `coreGit` with the answer's `bin` tail (file contents the request read). */
export function coreGitAnswer<T>(method: string, params: object, rounds: number, slowMs = 0): Promise<CoreAnswer<T>> {
	return heldAnswer(method, async () => ({ ...params, git: await gitRunner() }), rounds * DEFAULT_TIMEOUT_MS + slowMs);
}

/**
 * A request to the core that runs no git (disk care's walks, copies and removals), held as `heldRequest` says: a
 * stopped step cancels it and the lock's next holder waits until the core is done with it. `timeoutMs` is how long its
 * work may take.
 */
export function coreHeld<T>(method: string, params: object, timeoutMs: number): Promise<T> {
	return heldRequest(method, async () => params, timeoutMs);
}

/**
 * A gh request to the core (`gh.*`), held as `heldRequest` says: gh as `resolveBin` finds it (`null` when it is not
 * installed, which the core refuses as `gh_missing` where the request's rules say) and git for the checkout root
 * (`null` when missing). `timeoutMs` is how long its gh and git runs may take in all.
 */
export function coreGh<T>(method: string, params: object, timeoutMs: number): Promise<T> {
	return heldRequest(
		method,
		async () => {
			const bin = await resolveBin("gh");
			return { ...params, gh: bin ? await ghRunner(bin) : null, git: await gitRunner().catch(() => null) };
		},
		timeoutMs,
	);
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
	const env = await spawnEnv(opts.env);
	if (hold?.aborted) throw hold.reason;
	const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
	const child = spawn(bin, args, {
		cwd: opts.cwd,
		env,
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
	return execBin(bin, [...GIT_ARGS, ...args], { cwd, ...opts, env: { ...GIT_ENV, ...opts.env } });
}

/** Run gh at `bin` (core `gh.run`); resolves stdout text, rejects with gh's stderr on a non-zero exit or a cut output. */
export function gh(
	cwd: string,
	bin: string,
	args: string[],
	opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
	return heldRequest(
		"gh.run",
		async () => ({ gh: await ghRunner(bin), cwd, args, timeoutMs: opts.timeoutMs, env: opts.env }),
		opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
}

/** `ghText`'s timeout. */
export const GH_TEXT_TIMEOUT_MS = 30_000;

/**
 * Run gh (or git) at `bin` with gh's non-interactive env to completion as text (core `gh.text`); never rejects on a
 * non-zero exit, rejects when it could not run or ran past `GH_TEXT_TIMEOUT_MS`.
 */
export function ghText(
	cwd: string,
	bin: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	return heldRequest("gh.text", async () => ({ gh: await ghRunner(bin), cwd, args }), GH_TEXT_TIMEOUT_MS);
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
