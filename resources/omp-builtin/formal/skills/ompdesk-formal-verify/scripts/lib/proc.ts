import { type ChildProcess, spawn, spawnSync } from "node:child_process";

/** Exit protocol shared by every script of this skill. */
export const EXIT = { ok: 0, failed: 1, usage: 2, unavailable: 3 } as const;

/** A tool is missing and could not be prepared: report "not checked", never a pass (exit 3). */
export class Unavailable extends Error {
	override name = "Unavailable";
}

/** The command line was wrong (exit 2). */
export class UsageError extends Error {
	override name = "UsageError";
}

export interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	input?: string;
	/** Output beyond this many characters per stream is dropped (the tail is kept). */
	maxChars?: number;
	/** Called with every chunk of stdout and stderr as it arrives (progress output of a long run). */
	onData?: (chunk: string) => void;
}

export interface RunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Set when the process could not be started at all (ENOENT, EACCES). */
	spawnError?: Error;
}

/** Kills a child and everything it started: POSIX `kill(-pid)` (children run in their own group), Windows `taskkill /T /F`. */
function killTree(child: ChildProcess, sync = false): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform === "win32") {
		const args = ["/pid", String(pid), "/T", "/F"];
		try {
			if (sync) spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
			else spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
		} catch {
			child.kill();
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

/**
 * Children that are still running. They are started in their own process group (so a timeout can kill java and
 * whatever it spawned), which also means nobody else kills them when this script is interrupted: the script does.
 */
const live = new Set<ChildProcess>();
let guarded = false;

function killLive(): void {
	for (const child of live) killTree(child, true);
	live.clear();
}

function guardExit(): void {
	if (guarded) return;
	guarded = true;
	process.on("exit", killLive);
	const signals: [NodeJS.Signals, number][] = [
		["SIGINT", 2],
		["SIGTERM", 15],
		["SIGHUP", 1],
	];
	for (const [signal, number] of signals) {
		process.on(signal, () => {
			killLive();
			process.exit(128 + number);
		});
	}
}

/** Runs a program without a shell and collects its output. Never throws: a missing program is `spawnError`. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
	const maxChars = options.maxChars ?? 64 * 1024 * 1024;
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let started: ChildProcess | undefined;
	const finish = (result: RunResult): void => {
		if (settled) return;
		settled = true;
		if (started) live.delete(started);
		clearTimeout(timer);
		resolve(result);
	};
	let child: ChildProcess;
	try {
		child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
			detached: process.platform !== "win32",
		});
	} catch (error) {
		finish({
			code: null,
			signal: null,
			stdout,
			stderr,
			timedOut,
			spawnError: error instanceof Error ? error : new Error(String(error)),
		});
		return promise;
	}
	const keep = (text: string, chunk: string): string => {
		const joined = text + chunk;
		return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
	};
	guardExit();
	live.add(child);
	started = child;
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout = keep(stdout, chunk);
		options.onData?.(chunk);
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr = keep(stderr, chunk);
		options.onData?.(chunk);
	});
	child.on("error", error => finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error }));
	child.on("close", (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));
	if (options.input !== undefined && child.stdin) {
		child.stdin.on("error", () => {});
		child.stdin.end(options.input);
	}
	if (options.timeoutMs && options.timeoutMs > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, options.timeoutMs);
	}
	return promise;
}
