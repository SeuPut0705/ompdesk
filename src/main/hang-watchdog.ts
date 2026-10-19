/**
 * Main-thread hang watchdog, wiring (rules in `hang-watchdog-core.ts`, worker in
 * `hang-watchdog-worker.ts`). Observation only: a stall is recorded in
 * `<userData>/logs/main-thread-hang.json` and reported by the next launch as one
 * `gui-runtime.jsonl` line (`source: "main-thread-hang"`). The worker lives inside
 * this process and is unref'd, so it can neither outlive the app nor keep it open.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { app, powerMonitor } from "electron";
import {
	consumeHangMarker,
	HANG_CHECK_INTERVAL_MS,
	HANG_HEARTBEAT_INTERVAL_MS,
	HANG_TIMEOUT_MS,
	type HangWorkerData,
	type MainPhase,
	type MainToHangWorkerMessage,
} from "./hang-watchdog-core";
import { writeRuntimeLog } from "./runtime-log";

export function hangMarkerPath(): string {
	return join(app.getPath("userData"), "logs", "main-thread-hang.json");
}

/** Reports (and removes) the marker the previous run left, if any. Call before `installHangWatchdog`. */
export function reportPreviousHang(): void {
	const marker = consumeHangMarker(hangMarkerPath());
	if (!marker) return;
	writeRuntimeLog({
		source: "main-thread-hang",
		message: marker.selfRecovered
			? `Main thread stalled for ${Math.round(marker.unresponsiveMs / 1000)}s and recovered`
			: `Main thread stalled for ${Math.round(marker.unresponsiveMs / 1000)}s and never recovered`,
		details: {
			unresponsiveMs: Math.round(marker.unresponsiveMs),
			selfRecovered: marker.selfRecovered,
			detectedAt: new Date(marker.detectedAt).toISOString(),
			previousPid: marker.pid,
			phase: marker.phase ?? null,
			steps: marker.steps ?? [],
		},
	});
}

let postStep: ((message: MainToHangWorkerMessage) => void) | null = null;

/**
 * Main is about to run `step` of `phase`: the watchdog's marker names the last few steps, so a stall reads as
 * the step that never returned. Call it before a step that could block (sync fs, a native call, a teardown).
 * A no-op where the watchdog is off.
 */
export function markMainStep(phase: MainPhase, step: string): void {
	postStep?.({ type: "step", phase, step });
}

/**
 * Starts the watchdog worker. Packaged builds only unless `OMP_GUI_HANG_WATCHDOG=1`: a debugger
 * pausing a dev main thread is no hang. Never under vitest.
 */
export function installHangWatchdog(): void {
	if (process.env.VITEST) return;
	if (!app.isPackaged && process.env.OMP_GUI_HANG_WATCHDOG !== "1") return;
	const data: HangWorkerData = {
		pid: process.pid,
		markerPath: hangMarkerPath(),
		timeoutMs: HANG_TIMEOUT_MS,
		checkIntervalMs: HANG_CHECK_INTERVAL_MS,
	};
	let worker: Worker;
	try {
		mkdirSync(dirname(data.markerPath), { recursive: true });
		worker = new Worker(join(__dirname, "hang-watchdog-worker.js"), {
			name: "ompdesk-hang-watchdog",
			workerData: data,
		});
	} catch (error) {
		console.error("[hang-watchdog] worker failed to start:", error);
		return;
	}
	worker.unref();
	let stopped = false;
	const post = (message: MainToHangWorkerMessage): void => {
		try {
			worker.postMessage(message);
		} catch {
			// The worker already exited.
		}
	};
	postStep = post;
	const timer = setInterval(() => post({ type: "heartbeat" }), HANG_HEARTBEAT_INTERVAL_MS);
	timer.unref();
	const onResume = (): void => post({ type: "resume" });
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		postStep = null;
		clearInterval(timer);
		powerMonitor.off("resume", onResume);
		post({ type: "shutdown" });
	};
	powerMonitor.on("resume", onResume);
	worker.on("error", error => {
		console.error("[hang-watchdog] worker failed:", error);
		stop();
	});
	worker.once("exit", stop);
	app.once("will-quit", stop);
}
