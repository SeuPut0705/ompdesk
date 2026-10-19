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
		let marker: string | undefined;
		try {
			marker = readFileSync(markerPath(), "utf8");
		} catch {
			// No marker → normal hardware-accelerated path.
		}
		if (marker !== undefined && markerForcesSoftware(marker)) disabled = true;
		else if (marker !== undefined) {
			try {
				rmSync(markerPath(), { force: true });
			} catch {
				// A marker left in place is ignored on the next launch too.
			}
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

/**
 * Whether this launch composites in software: the crash marker or `--disable-gpu` turned hardware
 * acceleration off, or Chromium itself fell back (no GPU, a blocklisted driver, a CI runner). Chromium fills
 * `getGPUFeatureStatus()` only once the GPU process has reported, so this waits for `getGPUInfo("complete")`
 * first (read earlier, even a healthy GPU reports `disabled_software`; `basic` resolves too soon, `complete` does not). Asked once per launch and logged.
 */
export function softwareCompositing(): Promise<boolean> {
	softwareCompositingResult ??= app
		.getGPUInfo("complete")
		.catch(() => undefined)
		.then(() => {
			const features = app.getGPUFeatureStatus();
			const status = String(features.gpu_compositing);
			const software = !status.startsWith("enabled");
			writeRuntimeLog({
				source: "gpu-fallback",
				message: `gpu_compositing: ${status} (${software ? "software" : "hardware"})`,
				details: { features },
			});
			return software;
		});
	return softwareCompositingResult;
}

let softwareCompositingResult: Promise<boolean> | undefined;

let relaunchedForGpu = false;

/**
 * GPU-process exits that mean compositing is dead. clean-exit is lifecycle; killed is an outside
 * termination (Windows logoff, shutdown or an installer ends the whole tree with DBG_TERMINATE_PROCESS),
 * never a GPU failure.
 */
export function isGpuProcessCrash(details: { type: string; reason: string }): boolean {
	return details.type === "GPU" && details.reason !== "clean-exit" && details.reason !== "killed";
}

/** A marker an older build wrote for a non-crash exit (killed) is stale; an unreadable one still counts. */
export function markerForcesSoftware(marker: string): boolean {
	try {
		const reason: unknown = JSON.parse(marker)?.reason;
		return typeof reason !== "string" || isGpuProcessCrash({ type: "GPU", reason });
	} catch {
		return true;
	}
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
