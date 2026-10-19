/**
 * Which `gui-runtime.jsonl` lines mean something failed (pure; e2e/runtime-errors.ts reads the file). Writers:
 * src/main/runtime-log-core.ts and the sources listed in src/shared/ipc-types.ts `RuntimeErrorSource`.
 */

/** Sources whose every line is a failure. */
const FAILURE_SOURCES: Record<string, true> = {
	"react-render": true,
	"react-uncaught": true,
	"react-recoverable": true,
	"window-error": true,
	"unhandled-rejection": true,
	"renderer-console": true,
	"renderer-load": true,
	preload: true,
	"renderer-process": true,
	"renderer-unresponsive": true,
	"main-uncaught": true,
	"main-unhandled-rejection": true,
	"error-toast": true,
	// A background task failed without interrupting the user (ipc-types.ts), the quit watchdog included.
	"background-task": true,
};

export interface RuntimeLogLine {
	source?: unknown;
	message?: unknown;
	details?: unknown;
}

function detailsOf(entry: RuntimeLogLine): Record<string, unknown> {
	return typeof entry.details === "object" && entry.details !== null ? (entry.details as Record<string, unknown>) : {};
}

/** Whether one parsed log line reports a failure. */
export function isRuntimeFailure(entry: RuntimeLogLine): boolean {
	const source = typeof entry.source === "string" ? entry.source : "";
	if (FAILURE_SOURCES[source]) return true;
	const details = detailsOf(entry);
	switch (source) {
		// Electron's child-process-gone: only a clean exit is no failure.
		case "child-process":
			return details.reason !== "clean-exit";
		// A remote tab that never came up (remote-sidecar.ts): `stalled` past the deadline or `failed` at a step.
		case "remote-tab":
			return entry.message === "stalled" || entry.message === "failed";
		// A continuation whose omp never came up, or one whose restore and retry both left the turn not going on.
		case "turn-resume": {
			if (entry.message !== "continue" || details.cancelled === true) return false;
			if (details.ready === false) return true;
			const errored = details.restoreError !== undefined || details.retryError !== undefined;
			return errored && details.started !== true;
		}
		default:
			return false;
	}
}
