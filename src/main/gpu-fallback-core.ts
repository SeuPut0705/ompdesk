/**
 * The GPU fallback marker's rules (`<userData>/gpu-fallback.json`, wired in gpu-fallback.ts). A GPU process crash
 * in a hardware launch writes the marker with the GPU it crashed on; later launches render in software until the
 * GPU or its driver changed (a software launch records the GPU it sees) or `HARDWARE_RETRY_AFTER_MS` passed, then
 * one launch tries hardware again. That trial is recorded in the marker before it runs, so it happens once; it
 * clears the marker when it stays up, and a crash in it writes a fresh marker. Whether a crash may relaunch is
 * `gpuRelaunchDecision`'s (launch-guard-core.ts), so a trial can never start a cycle.
 */

/** The adapter Chromium names in `app.getGPUInfo("basic").gpuDevice`. */
export interface GpuIdentity {
	vendorId: number;
	deviceId: number;
	driverVersion?: string;
	driverDate?: string;
}

export interface GpuMarker {
	/** Epoch ms of the crash that wrote it (0 when an older build left no readable time). */
	at: number;
	reason?: string;
	exitCode?: number | null;
	/** The GPU the crash happened on, or the one the last hardware trial ran on. */
	gpu?: GpuIdentity;
	/** The GPU a later software launch saw. */
	seen?: GpuIdentity;
	/** Epoch ms of the last hardware trial. */
	trialAt?: number;
}

export const HARDWARE_RETRY_AFTER_MS = 7 * 24 * 60 * 60_000;
/** SwiftShader's device, which a software launch lists beside the real adapter. */
const SWIFTSHADER_VENDOR = 0xffff;

function identityFrom(value: unknown): GpuIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { vendorId, deviceId, driverVersion, driverDate } = value as Record<string, unknown>;
	if (typeof vendorId !== "number" || typeof deviceId !== "number" || vendorId === SWIFTSHADER_VENDOR)
		return undefined;
	return {
		vendorId,
		deviceId,
		...(typeof driverVersion === "string" && driverVersion ? { driverVersion } : {}),
		...(typeof driverDate === "string" && driverDate ? { driverDate } : {}),
	};
}

/** The active real adapter of `gpuDevice`, else the first real one. */
export function gpuIdentityOf(devices: unknown): GpuIdentity | undefined {
	if (!Array.isArray(devices)) return undefined;
	const real = devices.filter(device => identityFrom(device) !== undefined);
	const active = real.find(device => typeof device === "object" && "active" in device && device.active === true);
	return identityFrom(active ?? real[0]);
}

export type GpuChange = "gpu-changed" | "driver-changed";

export function gpuChange(before: GpuIdentity, after: GpuIdentity): GpuChange | undefined {
	if (before.vendorId !== after.vendorId || before.deviceId !== after.deviceId) return "gpu-changed";
	if (before.driverVersion !== after.driverVersion || before.driverDate !== after.driverDate) return "driver-changed";
	return undefined;
}

/** An unreadable marker still forces software rendering; its missing fields read as unknown. */
export function parseGpuMarker(text: string): GpuMarker {
	let value: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null) value = parsed as Record<string, unknown>;
	} catch {
		// Unknown time and GPU.
	}
	const at =
		typeof value.at === "string" ? Date.parse(value.at) : typeof value.at === "number" ? value.at : Number.NaN;
	const gpu = identityFrom(value.gpu);
	const seen = identityFrom(value.seen);
	return {
		at: Number.isFinite(at) ? at : 0,
		...(typeof value.reason === "string" ? { reason: value.reason } : {}),
		...(typeof value.exitCode === "number" || value.exitCode === null ? { exitCode: value.exitCode } : {}),
		...(gpu ? { gpu } : {}),
		...(seen ? { seen } : {}),
		...(typeof value.trialAt === "number" ? { trialAt: value.trialAt } : {}),
	};
}

export type MarkerDecision = { software: true } | { software: false; trial: GpuChange | "cool-off" };

/** Whether a launch under this marker renders in software or tries hardware once. */
export function gpuMarkerDecision(marker: GpuMarker, now: number): MarkerDecision {
	const change = marker.gpu && marker.seen ? gpuChange(marker.gpu, marker.seen) : undefined;
	if (change) return { software: false, trial: change };
	if (now - Math.max(marker.at, marker.trialAt ?? 0) >= HARDWARE_RETRY_AFTER_MS) {
		return { software: false, trial: "cool-off" };
	}
	return { software: true };
}

/** The marker a hardware trial leaves before it runs: the GPU it tries is the crash GPU from now on. */
export function markerForTrial(marker: GpuMarker, now: number): GpuMarker {
	const { seen, ...rest } = marker;
	return { ...rest, gpu: seen ?? marker.gpu, trialAt: now };
}
