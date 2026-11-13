/**
 * The `chrome` module's hang area (PROTOCOL.md §15.5; was `hang-watchdog.ts` and its worker): the shell watches Node's
 * main thread from a thread of its own. Node posts a heartbeat every second and the steps it is about to run; a stall
 * of over 5 s is recorded in `<userData>/logs/main-thread-hang.json`, and the next launch reports it as one
 * `gui-runtime.jsonl` line (`source: "main-thread-hang"`, written by the shell at ready: nothing for Node to call).
 * Observation only.
 */
import { app } from "electron";
import { chrome } from "./chrome";

/** What main was doing: launching, running, quitting (the teardown), or applying an update. */
export type MainPhase = "startup" | "running" | "quit" | "update";

export const HANG_HEARTBEAT_INTERVAL_MS = 1_000;

type NoParams = Record<string, never>;

export interface HangSpec {
	calls: Record<never, never>;
	posts: {
		/** Every second while the watchdog runs; the first one starts the watch. `pid` is this process's. */
		heartbeat: { pid: number };
		/** Main is about to run `step` of `phase`. */
		step: { phase: MainPhase; step: string };
		/** `will-quit`: Node stops beating, so the watch ends. */
		unwatch: NoParams;
	};
	events: Record<never, never>;
	asks: Record<never, never>;
}

let watching = false;
let timer: NodeJS.Timeout | undefined;

function warn(what: string): (error: unknown) => void {
	return error => console.warn(`[hang-watchdog] ${what}: ${String(error)}`);
}

/**
 * Main is about to run `step` of `phase`: the watchdog's marker names the last few steps, so a stall reads as the step
 * that never returned. Call it before a step that could block (sync fs, a native call, a teardown). A no-op where the
 * watchdog is off.
 */
export function markMainStep(phase: MainPhase, step: string): void {
	if (!watching) return;
	chrome().post("step", { phase, step }).catch(warn("step"));
}

/**
 * Starts the watchdog. Packaged builds only unless `OMP_GUI_HANG_WATCHDOG=1`: a debugger pausing a dev main thread is
 * no hang. Never under vitest.
 */
export function installHangWatchdog(): void {
	if (process.env.VITEST) return;
	if (!app.isPackaged && process.env.OMP_GUI_HANG_WATCHDOG !== "1") return;
	if (watching) return;
	watching = true;
	const beat = (): void => {
		chrome().post("heartbeat", { pid: process.pid }).catch(warn("heartbeat"));
	};
	beat();
	timer = setInterval(beat, HANG_HEARTBEAT_INTERVAL_MS);
	timer.unref();
	app.once("will-quit", stopHangWatchdog);
}

/** The quit began: the heartbeats stop, and the shell stops judging with them. */
export function stopHangWatchdog(): void {
	if (!watching) return;
	watching = false;
	clearInterval(timer);
	timer = undefined;
	chrome().post("unwatch", {}).catch(warn("unwatch"));
}
