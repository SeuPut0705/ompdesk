/**
 * Rules that keep OMPdesk from opening and closing by itself. Pure: `launch-guard.ts` reads and writes the
 * history (`<userData>/launch-history.json`), `gpu-fallback.ts` asks before its automatic relaunch.
 *
 * A launch is recorded as it starts and marked stable once it ran `STABLE_AFTER_MS` or quit cleanly. A launch
 * that ended any other way (a crash, the GPU fallback's `app.exit`, a kill) stays unstable. When the last
 * `CRASH_LOOP_LAUNCHES` launches all ended unstable within `CRASH_LOOP_WINDOW_MS`, the next one starts in safe
 * mode: software rendering, no automatic relaunch, machine setup paused.
 */

export interface LaunchRecord {
	/** Epoch ms the launch started. */
	at: number;
	/** It ran `STABLE_AFTER_MS` or quit cleanly. */
	stable?: true;
	/** Epoch ms it relaunched itself for a GPU process crash. */
	gpuRelaunchAt?: number;
	/** It started in safe mode. */
	safeMode?: true;
}

export const STABLE_AFTER_MS = 20_000;
export const CRASH_LOOP_LAUNCHES = 3;
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
/** At most one automatic GPU relaunch per this long, across processes. */
export const GPU_RELAUNCH_COOLDOWN_MS = 10 * 60_000;
/** Launches the history file keeps. */
export const HISTORY_KEEP = 10;

/** An unreadable or foreign history is no history: the guard is advisory and never blocks a start. */
export function parseLaunchHistory(text: string | undefined): LaunchRecord[] {
	if (!text) return [];
	try {
		const value: unknown = JSON.parse(text);
		if (!Array.isArray(value)) return [];
		return value.flatMap((entry): LaunchRecord[] => {
			if (typeof entry !== "object" || entry === null) return [];
			const { at, stable, gpuRelaunchAt, safeMode } = entry as Record<string, unknown>;
			if (typeof at !== "number" || !Number.isFinite(at)) return [];
			return [
				{
					at,
					...(stable === true ? { stable: true as const } : {}),
					...(typeof gpuRelaunchAt === "number" ? { gpuRelaunchAt } : {}),
					...(safeMode === true ? { safeMode: true as const } : {}),
				},
			];
		});
	} catch {
		return [];
	}
}

/** The previous launches (this one not yet recorded) form a crash loop. */
export function crashLoopDetected(previous: readonly LaunchRecord[], now: number): boolean {
	const recent = previous.slice(-CRASH_LOOP_LAUNCHES);
	if (recent.length < CRASH_LOOP_LAUNCHES) return false;
	return recent.every(launch => !launch.stable && now - launch.at >= 0 && now - launch.at <= CRASH_LOOP_WINDOW_MS);
}

export type GpuRelaunchDecision =
	| { relaunch: true }
	| { relaunch: false; why: "software" | "safe-mode" | "cooldown"; lastRelaunchAt?: number };

/**
 * Whether a GPU process crash may relaunch the app into software rendering. Never from a launch that already
 * renders in software (Windows still runs a GPU process for SwiftShader/WARP, and its crash would start the
 * same launch again forever), never in safe mode, and at most once per `GPU_RELAUNCH_COOLDOWN_MS`.
 */
export function gpuRelaunchDecision(input: {
	software: boolean;
	safeMode: boolean;
	history: readonly LaunchRecord[];
	now: number;
}): GpuRelaunchDecision {
	if (input.safeMode) return { relaunch: false, why: "safe-mode" };
	if (input.software) return { relaunch: false, why: "software" };
	const last = input.history.reduce<number | undefined>(
		(latest, launch) =>
			launch.gpuRelaunchAt !== undefined && (latest === undefined || launch.gpuRelaunchAt > latest)
				? launch.gpuRelaunchAt
				: latest,
		undefined,
	);
	if (last !== undefined && input.now - last < GPU_RELAUNCH_COOLDOWN_MS) {
		return { relaunch: false, why: "cooldown", lastRelaunchAt: last };
	}
	return { relaunch: true };
}
