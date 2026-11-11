import { type ChildProcess, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/**
 * How long an omp gets to end by itself once its stop began (SIGTERM; on Windows its stdin ended) before it is killed.
 * A Bun process whose main thread is blocked runs its SIGTERM handler only once the thread frees (measured: a 6 s busy
 * loop ran the handler 5 s after the signal), and one that never frees kept every new omp on the machine stalled for
 * minutes after the app quit (8 Nov 2026): past this bound the stop no longer asks.
 */
export const STOP_GRACE_MS = 5_000;
/** After the kill, how long the stop still waits for the exit (a process in uninterruptible sleep outlasts SIGKILL). */
const KILL_WAIT_MS = 2_000;
/**
 * What stock's exit writes to stderr when it waits on one thing alone (`@oh-my-pi/pi-utils` postmortem.ts: the hold's
 * message, then "(up to N s)…"). The hold that matters is the login refresh (`pi-ai` auth/refresh.ts, up to 125 s):
 * the provider has already swapped the refresh token, so an omp killed before it saved the new one leaves a spent
 * token in the store every omp shares, and the account drops off the list at the next refresh (`invalid_grant`).
 */
const EXIT_HOLD = /\(up to (\d+) s\)…/;
/** Past the time an exit hold asked for, how long the omp still has to end before the kill. */
const HOLD_SLACK_MS = 2_000;
/** The longest a stop is held for an omp's exit hold, whatever it asks for (stock's longest is 125 s). */
export const STOP_HOLD_MAX_MS = 130_000;
/** How often a stop of a pid this app is not the parent of looks whether it is gone. */
const PID_POLL_MS = 100;

/**
 * How every omp is spawned: on POSIX in a process group of its own (`detached`), so the kill at the end of a stop takes
 * the tools it started with it. Windows keeps the console (`detached` would open one) and kills the tree by pid.
 */
export const OMP_SPAWN_GROUP = { detached: process.platform !== "win32" } as const;

export interface StopOptions {
	/**
	 * Close the omp's stdin first and give it this long to end by itself before the signal: stock emits
	 * `session_shutdown` (ai-memory's `session-end` hook, which writes the handoff) only when its stdin ends.
	 */
	stdinGraceMs?: number;
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** One stop per process: a second caller (a quit over a restart's stop) waits on the same one. */
const stops = new WeakMap<ChildProcess, Promise<void>>();

function exitOf(child: ChildProcess): Promise<void> {
	if (!running(child)) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	child.once("exit", () => resolve());
	return promise;
}

/** True when `done` settled within `ms`. */
function within(done: Promise<void>, ms: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), ms);
	void done.then(() => {
		clearTimeout(timer);
		resolve(true);
	});
	return promise;
}

/**
 * Until when the omp asked not to be killed, read from its stderr from now on (0: it asked for nothing). A hold never
 * reaches past `STOP_HOLD_MAX_MS` from now.
 */
function exitHold(child: ChildProcess, pid: number): () => number {
	const latest = Date.now() + STOP_HOLD_MAX_MS;
	let until = 0;
	const onData = (chunk: Buffer | string): void => {
		const seconds = Number(EXIT_HOLD.exec(String(chunk))?.[1]);
		if (!seconds) return;
		until = Math.min(Date.now() + seconds * 1_000 + HOLD_SLACK_MS, latest);
		console.warn(`[omp-stop] omp ${pid} waits to save before it exits (up to ${seconds} s): its kill waits too`);
	};
	child.stderr?.on("data", onData);
	child.once("exit", () => child.stderr?.off("data", onData));
	return () => until;
}

/** True when `done` settled within `ms`, or within the hold the omp asked for meanwhile. */
async function withinGrace(done: Promise<void>, ms: number, heldUntil: () => number): Promise<boolean> {
	if (await within(done, ms)) return true;
	for (;;) {
		const left = heldUntil() - Date.now();
		if (left <= 0) return false;
		if (await within(done, left)) return true;
	}
}

/** Whether `pid` names a live process (one owned by another user answers `EPERM`). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Kills `pid` and what it started, now. POSIX: SIGKILL to its process group (`OMP_SPAWN_GROUP`), else the pid alone
 * (an omp an older OMPdesk spawned in its own group). Windows: `taskkill /T /F` (omp runs behind a `.cmd`/`.exe` shim
 * whose real omp would survive a kill of the shim); with WMI down taskkill kills nothing and exits 1, then `fallBack`.
 */
function killTree(pid: number, fallBack: () => void): void {
	if (process.platform !== "win32") {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		return;
	}
	const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	killer.once("error", fallBack);
	killer.once("exit", code => {
		if (code !== 0) fallBack();
	});
}

/**
 * The one stop of an omp: every path (tab close, restart, sleep, a revive, the quit, an update's relaunch) goes through
 * it, and it resolves only once the process has exited, so a replacement on the same tab or session never overlaps it.
 * The omp is first asked the way a stop should read in its session journal: stock journals `session_exit` and a
 * relaunch's restore dates the stop by it (`cutByEarlierStop`, `shutdownMarks` in restart-core.ts). POSIX: SIGTERM,
 * whose handler disposes the session. Windows has no signals and a tree kill journals nothing, so its stdin ends (stock
 * disposes the session then, as on an app quit). An omp still running `STOP_GRACE_MS` later is killed with its tools
 * (`killTree`), unless it said it waits to save (`EXIT_HOLD`): then the kill waits for the time it named, at most
 * `STOP_HOLD_MAX_MS`. The shim waits for the omp on Windows, so its exit means the omp is gone.
 */
export function stopOmp(child: ChildProcess, options: StopOptions = {}): Promise<void> {
	const known = stops.get(child);
	if (known) return known;
	const exited = exitOf(child);
	if (!running(child) || child.pid === undefined) return exited;
	const pid = child.pid;
	const stop = (async () => {
		const heldUntil = exitHold(child, pid);
		const stdinGrace = options.stdinGraceMs ?? 0;
		if (stdinGrace > 0 && child.stdin) {
			child.stdin.end();
			if (await withinGrace(exited, stdinGrace, heldUntil)) return;
		}
		if (process.platform === "win32") child.stdin?.end();
		else child.kill("SIGTERM");
		if (await withinGrace(exited, STOP_GRACE_MS, heldUntil)) return;
		console.warn(`[omp-stop] omp ${pid} still runs after its stop's grace: killing it`);
		killTree(pid, () => {
			if (!running(child)) return;
			child.stdin?.end();
			child.kill();
		});
		await within(exited, KILL_WAIT_MS);
	})();
	stops.set(child, stop);
	return stop;
}

/**
 * Stops an omp this app did not spawn in this run (one an earlier instance left behind, `omp-processes.ts`): the same
 * steps as `stopOmp` over a bare pid. No `exit` event reaches a process that is not the parent, so the OS is asked for
 * the pid every `PID_POLL_MS`. Resolves once the pid is gone, or after the kill's wait, with whether it is gone.
 */
export async function stopOmpPid(pid: number): Promise<boolean> {
	const goneWithin = async (ms: number): Promise<boolean> => {
		for (const until = Date.now() + ms; Date.now() < until; ) {
			if (!pidAlive(pid)) return true;
			await delay(PID_POLL_MS);
		}
		return !pidAlive(pid);
	};
	if (!pidAlive(pid)) return true;
	if (process.platform !== "win32") {
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
		if (await goneWithin(STOP_GRACE_MS)) return true;
	}
	console.warn(`[omp-stop] leftover omp ${pid} still runs: killing it`);
	killTree(pid, () => {
		try {
			process.kill(pid);
		} catch {}
	});
	return goneWithin(KILL_WAIT_MS);
}
