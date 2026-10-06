/**
 * Software-rendering escape hatch. When the Chromium GPU process crashes on a
 * machine (typical on Windows 10 with old Intel graphics drivers), every
 * window goes black while the app keeps running — the classic blank-screen
 * failure. Relaunching once with hardware acceleration disabled is the
 * standard recovery.
 *
 * The marker must live on disk and be read before `app.whenReady()` —
 * `app.disableHardwareAcceleration()` is only legal that early.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { writeRuntimeLog } from "./runtime-log";

const MARKER_FILENAME = "gpu-fallback.json";

function markerPath(): string {
	return join(app.getPath("userData"), MARKER_FILENAME);
}

/**
 * Call before `app.whenReady()`: disables GPU compositing when a previous GPU
 * crash tripped the fallback, or when the user passed --disable-gpu /
 * --enable-gpu explicitly (the latter clears a stale marker).
 */
export function applyGpuFallbackIfNeeded(): boolean {
	let disabled = false;
	if (app.commandLine.hasSwitch("enable-gpu")) {
		try {
			rmSync(markerPath(), { force: true });
		} catch {
			// Marker is advisory; failing to clear it must not block startup.
		}
	} else if (app.commandLine.hasSwitch("disable-gpu")) {
		disabled = true;
	} else {
		try {
			readFileSync(markerPath(), "utf8");
			disabled = true;
		} catch {
			// No marker → normal hardware-accelerated path.
		}
	}
	if (disabled) {
		app.disableHardwareAcceleration();
		writeRuntimeLog({
			source: "gpu-fallback",
			message: "Hardware acceleration disabled (crash marker or --disable-gpu)",
		});
	}
	return disabled;
}

let relaunchedForGpu = false;

/** GPU-process exits that mean compositing is dead — clean-exit is lifecycle. */
export function isGpuProcessCrash(details: { type: string; reason: string }): boolean {
	return details.type === "GPU" && details.reason !== "clean-exit";
}

/**
 * Called from the `child-process-gone` handler. A dead GPU process is
 * unrecoverable in place — mark software rendering and relaunch once so the
 * user gets a usable window back instead of a black screen.
 */
export function handleGpuProcessGone(details: { type: string; reason: string; exitCode: number | undefined }): void {
	if (!isGpuProcessCrash(details) || relaunchedForGpu) return;
	relaunchedForGpu = true;
	try {
		writeFileSync(
			markerPath(),
			JSON.stringify({ at: new Date().toISOString(), reason: details.reason, exitCode: details.exitCode ?? null }),
		);
	} catch {
		// Without the marker the relaunch just retries hardware acceleration.
	}
	writeRuntimeLog({
		source: "gpu-fallback",
		message: `GPU process exited (${details.reason}) — relaunching with software rendering`,
		details: { reason: details.reason, exitCode: details.exitCode ?? null },
	});
	app.relaunch();
	app.exit(0);
}
