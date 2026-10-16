/**
 * Whether omp can run on this computer, as machine setup last detected it
 * (src/main/setup/). While it is `missing` (not installed, too old, broken, or
 * being installed) nothing starts a stock-helper worker or resolves omp for a
 * tab: the setup screen is the one place that speaks about it, and every other
 * surface stays calm (`waiting` tabs, an empty session list). `unknown` until
 * setup's first detection: callers then resolve omp themselves, so a normal
 * launch never waits for detection.
 */
import type { SetupState } from "../shared/setup";

export type OmpAvailability = "unknown" | "missing" | "usable";

let availability: OmpAvailability = "unknown";
/** A request was refused for lack of omp since it was last usable: its readers must read again. */
let refused = false;

/** A stock-helper request refused because omp is not usable yet; callers show nothing for it, never a failure. */
export class OmpUnavailableError extends Error {
	readonly code = "omp_unavailable";
}

/** The error for a request refused for lack of omp; remembers it so its readers read again once omp is usable. */
export function refuseWithoutOmp(message: string): OmpUnavailableError {
	refused = true;
	return new OmpUnavailableError(message);
}

export function ompAvailability(): OmpAvailability {
	return availability;
}

/** What waited for omp, now that it is usable. */
export interface OmpUsableNow {
	/** Something was refused meanwhile (a session-list read): its readers should read again. */
	refused: boolean;
}

/** Follows machine setup's state; non-null once, when omp has just become usable (from `unknown` or `missing`). */
export function followSetupState(state: SetupState): OmpUsableNow | null {
	const presence = state.items.find(item => item.id === "omp")?.presence ?? null;
	const next: OmpAvailability = presence === null ? "unknown" : state.ompReady ? "usable" : "missing";
	const previous = availability;
	availability = next;
	if (next !== "usable" || previous === "usable") return null;
	const now = { refused: refused || previous === "missing" };
	refused = false;
	return now;
}

/** Test seam: back to the launch state. */
export function resetOmpAvailability(): void {
	availability = "unknown";
	refused = false;
}
