import { type ChildProcess, spawn } from "node:child_process";

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

function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
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

/** Runs a program without a shell and collects its output. Never throws: a missing program is `spawnError`. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
	const maxChars = options.maxChars ?? 64 * 1024 * 1024;
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = (result: RunResult): void => {
		if (settled) return;
		settled = true;
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
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout = keep(stdout, chunk);
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr = keep(stderr, chunk);
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
