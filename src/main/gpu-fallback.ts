/**
 * Software-rendering escape hatch. When the Chromium GPU process crashes on a
 * machine (typical on Windows 10 with old Intel graphics drivers), every
 * window can go black while the app keeps running. Relaunching once with
 * hardware acceleration disabled is the recovery.
 *
 * Never twice: with hardware acceleration off Chromium still runs a GPU
 * process (SwiftShader, WARP on Windows), restarts it itself when it dies and
 * falls back further on its own. Relaunching from such a launch only started
 * the same software launch again, so a laptop whose software GPU process also
 * died opened and closed OMPdesk forever (v0.44.0). `gpuRelaunchDecision`
 * (launch-guard-core.ts) allows a relaunch only from a hardware launch outside
 * safe mode, at most once per 10 minutes across processes.
 *
 * The marker must live on disk and be read before `app.whenReady()` —
 * `app.disableHardwareAcceleration()` is only legal that early.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { launchHistory, launchSafeMode, noteGpuRelaunch } from "./launch-guard";
import { gpuRelaunchDecision } from "./launch-guard-core";
import { writeRuntimeLog } from "./runtime-log";

const MARKER_FILENAME = "gpu-fallback.json";

function markerPath(): string {
	return join(app.getPath("userData"), MARKER_FILENAME);
}

/**
 * Call before `app.whenReady()`: disables GPU compositing in safe mode, when a previous GPU
 * crash tripped the fallback, or when the user passed --disable-gpu /
 * --enable-gpu explicitly (the latter clears a stale marker).
 */
export function applyGpuFallbackIfNeeded(safeMode = false): boolean {
	let disabled = safeMode;
	if (safeMode) {
		// Safe mode renders in software whatever the switches or the marker say.
	} else if (app.commandLine.hasSwitch("enable-gpu")) {
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
	softwareLaunch = disabled;
	if (disabled) {
		app.disableHardwareAcceleration();
		writeRuntimeLog({
			source: "gpu-fallback",
			message: safeMode
				? "Hardware acceleration disabled (safe mode)"
				: "Hardware acceleration disabled (crash marker or --disable-gpu)",
		});
	}
	return disabled;
}

/** This launch turned hardware acceleration off before ready. */
let softwareLaunch = false;

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

let gpuCrashHandled = false;

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
 * Called from the `child-process-gone` handler. A hardware launch whose GPU process dies writes the marker and
 * relaunches into software rendering, once; every other launch leaves recovery to Chromium.
 */
export function handleGpuProcessGone(details: { type: string; reason: string; exitCode: number | undefined }): void {
	if (!isGpuProcessCrash(details) || gpuCrashHandled) return;
	gpuCrashHandled = true;
	const exit = { reason: details.reason, exitCode: details.exitCode ?? null };
	const now = Date.now();
	const decision = gpuRelaunchDecision({
		software: softwareLaunch,
		safeMode: launchSafeMode(),
		history: launchHistory(),
		now,
	});
	if (!softwareLaunch) {
		try {
			writeFileSync(markerPath(), JSON.stringify({ at: new Date(now).toISOString(), ...exit }));
		} catch {
			// Without the marker the next launch just retries hardware acceleration.
		}
	}
	if (!decision.relaunch) {
		writeRuntimeLog({
			source: "gpu-fallback",
			message: `GPU process exited (${details.reason}): no relaunch (${decision.why}); Chromium restarts it`,
			details: { ...exit, why: decision.why, lastRelaunchAt: decision.lastRelaunchAt ?? null },
		});
		return;
	}
	writeRuntimeLog({
		source: "gpu-fallback",
		message: `GPU process exited (${details.reason}): relaunching with software rendering`,
		details: exit,
	});
	noteGpuRelaunch(now);
	app.relaunch();
	app.exit(0);
}
