/**
 * `git` / `gh` subprocess runner for the GUI-side git commands. No shell, argv
 * arrays only (Windows-safe); binaries resolve against the login-shell PATH
 * (same merge as the omp runtime) because a Finder-launched app inherits
 * launchd's bare PATH, where Homebrew's `gh` is missing.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnPath } from "../../shell-env";

/** Timeout for a `git`/`gh` call that names none; commands' answer budgets count in it. */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** Hard cap on captured stdout; matches gh's 8 MiB output ceiling. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

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
}

let pathPromise: Promise<string> | null = null;
const binCache = new Map<string, Promise<string | null>>();

function lookupPath(): Promise<string> {
	pathPromise ??= spawnPath();
	return pathPromise;
}

/** First `name` (or `name.exe` on Windows) found on `pathEnv`. */
export function findOnPath(name: string, pathEnv: string, platform: NodeJS.Platform = process.platform): string | null {
	const names = platform === "win32" ? [`${name}.exe`, name] : [name];
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		for (const file of names) {
			const candidate = join(dir, file);
			try {
				if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
			} catch {
				// Unreadable entry — keep looking.
			}
		}
	}
	return null;
}

/** Absolute path to `git`/`gh`, or null when not installed. */
export function resolveBin(name: "git" | "gh"): Promise<string | null> {
	let pending = binCache.get(name);
	if (!pending) {
		pending = lookupPath().then(pathEnv => findOnPath(name, pathEnv));
		binCache.set(name, pending);
		// A missing binary is re-probed next call (the user may install it).
		void pending.then(bin => {
			if (!bin && binCache.get(name) === pending) binCache.delete(name);
		});
	}
	return pending;
}

/** Spawn `bin args`; never rejects on non-zero exit, rejects on spawn failure / timeout. */
export async function execBin(bin: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
	const pathEnv = await lookupPath();
	const { promise, resolve, reject } = Promise.withResolvers<ExecResult>();
	const child = spawn(bin, args, {
		cwd: opts.cwd,
		// A read-only `git status` must not take `.git/index.lock` to refresh the index: the agent's own git would fail on it.
		env: { ...process.env, PATH: pathEnv, GIT_OPTIONAL_LOCKS: "0", ...opts.env },
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const chunks: Buffer[] = [];
	let size = 0;
	let truncated = false;
	let stderr = "";
	const timer = setTimeout(() => {
		child.kill();
		reject(new Error(`${args[0] ?? bin} timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => {
		if (truncated) return;
		if (size + chunk.length > maxBytes) {
			chunks.push(chunk.subarray(0, maxBytes - size));
			size = maxBytes;
			truncated = true;
			child.kill();
			return;
		}
		chunks.push(chunk);
		size += chunk.length;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		if (stderr.length < 64 * 1024) stderr += chunk;
	});
	child.on("error", err => {
		clearTimeout(timer);
		reject(err);
	});
	child.on("close", code => {
		clearTimeout(timer);
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
	const bin = await resolveBin("git");
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

/** Per-repository mutex for worktree/branch/config mutations (git uses O_EXCL lock files with no waiter). */
const repoLocks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const previous = repoLocks.get(root) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	const settled = run.catch(() => undefined);
	repoLocks.set(root, settled);
	void settled.then(() => {
		if (repoLocks.get(root) === settled) repoLocks.delete(root);
	});
	return run;
}
