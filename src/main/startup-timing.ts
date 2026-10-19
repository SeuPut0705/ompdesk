/**
 * Launch timings in `gui-runtime.jsonl` (`source: "startup-timing"`, the mark
 * as `message`, `details.sinceLaunchMs` = ms since this main process started,
 * on main's clock for every mark, renderer marks included): how long a launch
 * takes to reach the first tab's ready session and the first-run wizard, and
 * how long the wizard takes once machine setup made omp usable. Each mark is
 * written once per launch; e2e/first-run-no-omp.e2e.ts reads them.
 */
import { isRendererStartupMark, type StartupMark } from "../shared/startup-timing";
import { markMainStep } from "./hang-watchdog";
import { writeRuntimeLog } from "./runtime-log";

const written = new Set<StartupMark>();

export function markStartup(mark: StartupMark, details: Record<string, string | number | boolean> = {}): void {
	if (written.has(mark)) return;
	written.add(mark);
	// The first-run check is the last launch mark: from there main is running.
	markMainStep(mark === "first-run-check" ? "running" : "startup", mark);
	writeRuntimeLog({
		source: "startup-timing",
		message: mark,
		details: { ...details, sinceLaunchMs: Math.round(performance.now()) },
	});
}

/** A mark a renderer sent over IPC: only the renderer's own names count. */
export function markStartupFromRenderer(mark: unknown): void {
	if (isRendererStartupMark(mark)) markStartup(mark);
}
