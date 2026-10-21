/**
 * The launch history behind the crash-loop guard (rules: `launch-guard-core.ts`). Electron-free: index.ts
 * passes the file (`<userData>/launch-history.json`) and decides when a launch counts as stable. The history is
 * advisory: an unreadable or unwritable file never blocks a start.
 */
import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "./atomic-file";
import { crashLoopDetected, HISTORY_KEEP, type LaunchRecord, parseLaunchHistory } from "./launch-guard-core";

interface Guard {
	path: string;
	previous: LaunchRecord[];
	current: LaunchRecord;
}

let guard: Guard | undefined;

function save(state: Guard): void {
	try {
		writeFileAtomicSync(state.path, JSON.stringify([...state.previous, state.current].slice(-HISTORY_KEEP)));
	} catch {
		// Advisory: a launch that cannot record itself still starts.
	}
}

/**
 * Records this launch and says whether the launches before it form a crash loop, in which case this one runs
 * in safe mode. Call once, after the single-instance lock is held (a second instance quits at once and must not
 * count) and before `app.whenReady()` (safe mode turns hardware acceleration off).
 */
export function startLaunchGuard(
	path: string,
	now = Date.now(),
): { safeMode: boolean; previous: readonly LaunchRecord[] } {
	let text: string | undefined;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// No history yet.
	}
	const previous = parseLaunchHistory(text);
	const safeMode = crashLoopDetected(previous, now);
	guard = { path, previous, current: { at: now, ...(safeMode ? { safeMode: true } : {}) } };
	save(guard);
	return { safeMode, previous };
}

/** This launch ran long enough or quits cleanly: it ends no crash loop. */
export function markLaunchStable(): void {
	if (!guard || guard.current.stable) return;
	guard.current.stable = true;
	save(guard);
}

/** This launch is about to relaunch itself for a GPU process crash. */
export function noteGpuRelaunch(at = Date.now()): void {
	if (!guard) return;
	guard.current.gpuRelaunchAt = at;
	save(guard);
}

/** This launch started in safe mode (false when the guard never started: dev, tests, a second instance). */
export function launchSafeMode(): boolean {
	return guard?.current.safeMode === true;
}

/** Every recorded launch, this one last. */
export function launchHistory(): readonly LaunchRecord[] {
	return guard ? [...guard.previous, guard.current] : [];
}
