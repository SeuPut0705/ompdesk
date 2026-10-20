/**
 * omp keeps itself current (src/main/omp-updater.ts): while OMPdesk runs it
 * looks up npm's latest `@oh-my-pi/pi-coding-agent` and, when that is newer
 * than the installed omp, runs stock `omp update` on its own. OMPdesk's own
 * updates stay manual (Settings › Updates & about). Each computer — a paired
 * host included — updates its own omp under its own pref, always through its
 * own updater: a client only asks the host to run it (`host.ompUpdate.now`)
 * and follows the state the host pushes; it never runs `omp update` there.
 */

/**
 * - `check`: the registry lookup failed (`detail` is the reason).
 * - `install`: `omp update` failed or could not start.
 * - `not-updated`: it exited cleanly but omp is still older than the registry's latest.
 * - `unusable`: the new omp does not run (or is below the minimum); tabs stay on the omp they have.
 * - `cancelled`: the user cancelled the install from This computer.
 */
export const OMP_UPDATE_FAILURE_REASONS = ["check", "install", "not-updated", "unusable", "cancelled"] as const;
export type OmpUpdateFailureReason = (typeof OMP_UPDATE_FAILURE_REASONS)[number];

export interface OmpUpdateFailure {
	reason: OmpUpdateFailureReason;
	/** Last lines of the installer's output, or the lookup error. */
	detail?: string;
}

export interface OmpUpdateState {
	/** The pref: whether scheduled checks may install. A manual "Update now" works either way. */
	enabled: boolean;
	/** This launch schedules checks (packaged app, or a test launch with a fake installer and registry); dev and test launches never do. */
	scheduled: boolean;
	phase: "idle" | "checking" | "updating";
	/** The omp that runs on this computer now; null before detection or while omp is missing. */
	installed: string | null;
	/** npm's latest as of the last successful check. */
	latest: string | null;
	/** When the last check finished (ms since the epoch); null before the first. */
	checkedAt: number | null;
	/** The newest version this launch installed on its own. */
	updatedTo: string | null;
	/** Why the last attempt failed; cleared by the next success. Kept until then. */
	failure: OmpUpdateFailure | null;
}

/** What the renderer toasts once an update has been installed ("omp updated to X"). */
export interface OmpUpdatedNotice {
	version: string;
}
