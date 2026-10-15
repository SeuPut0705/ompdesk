import { create } from "zustand";
import type { UsageReport } from "../../shared/rpc-types";
import { PREFS_BOOT_RETRY_MS, readPref } from "../lib/prefs-read";

/**
 * Turns stopped by a provider usage limit, booked to resume when the limit
 * resets: session id → reset time (epoch ms). `useQuotaResume` runs stock
 * `retry` on the session's tab once the time has come and the tab is idle.
 * Saved in prefs (main), so a booking outlives a restart; one whose session
 * stays closed for a day past its time is dropped.
 */
export const QUOTA_RESUME_PREF = "quotaResume";

/** How long past its reset a booking still waits for its session's tab. */
export const QUOTA_RESUME_GRACE_MS = 24 * 60 * 60 * 1000;

interface QuotaResumeState {
	reservations: Record<string, number>;
	/** Whether the stored bookings were read; until then changes are held here and not written. */
	loaded: boolean;
	load: () => Promise<void>;
	reserve: (sessionId: string, resetAt: number) => void;
	cancel: (sessionId: string) => void;
	reset: () => void;
}

function parseReservations(value: unknown): Record<string, number> {
	if (typeof value !== "object" || value === null) return {};
	const reservations: Record<string, number> = {};
	for (const [sessionId, resetAt] of Object.entries(value))
		if (typeof resetAt === "number" && Number.isFinite(resetAt)) reservations[sessionId] = resetAt;
	return reservations;
}

function persist(reservations: Record<string, number>): void {
	// A failed write only loses the booking across a restart; this run still resumes.
	void window.omp.prefs
		.set(QUOTA_RESUME_PREF, Object.keys(reservations).length ? reservations : undefined)
		.catch(() => {});
}

export const useQuotaResumeStore = create<QuotaResumeState>()((set, get) => {
	/** Set when a booking changed before the stored ones were read: the merge must then be written back. */
	let changedBeforeRead = false;
	/** Sessions whose booking was cancelled before the read, so the stored copy does not bring them back. */
	const cancelledBeforeRead = new Set<string>();

	/**
	 * Reads the stored bookings and merges them with this run's. A failed read
	 * leaves the store unloaded: the stored bookings are unknown, so nothing
	 * may be written over them yet.
	 */
	const load = async (retryDelaysMs: readonly number[]): Promise<void> => {
		if (get().loaded) return;
		const read = await readPref(QUOTA_RESUME_PREF, retryDelaysMs);
		// Another read (boot backoff or a change's own) may have landed meanwhile.
		if (!read.ok || get().loaded) return;
		const reservations = { ...parseReservations(read.value), ...get().reservations };
		for (const sessionId of cancelledBeforeRead) delete reservations[sessionId];
		const write = changedBeforeRead;
		cancelledBeforeRead.clear();
		changedBeforeRead = false;
		set({ reservations, loaded: true });
		if (write) persist(reservations);
	};

	return {
		reservations: {},
		loaded: false,
		load: () => load(PREFS_BOOT_RETRY_MS),
		reserve: (sessionId, resetAt) => {
			const reservations = { ...get().reservations, [sessionId]: resetAt };
			set({ reservations });
			cancelledBeforeRead.delete(sessionId);
			if (get().loaded) persist(reservations);
			else {
				changedBeforeRead = true;
				void load([]);
			}
		},
		cancel: sessionId => {
			if (!(sessionId in get().reservations)) return;
			const { [sessionId]: _, ...reservations } = get().reservations;
			set({ reservations });
			if (get().loaded) persist(reservations);
			else {
				changedBeforeRead = true;
				cancelledBeforeRead.add(sessionId);
				void load([]);
			}
		},
		reset: () => {
			changedBeforeRead = false;
			cancelledBeforeRead.clear();
			set({ reservations: {}, loaded: false });
		},
	};
});

/**
 * When the provider's usage limit lets `provider` run again: stock may rotate
 * to any of the provider's accounts, so the first account to reset frees the
 * session. Unknown (undefined) while any account is not limited — the stop
 * was then a short rate limit, not a quota — or no report names a reset.
 */
export function quotaResetAt(
	reports: readonly UsageReport[],
	provider: string | undefined,
	now: number,
): number | undefined {
	const accounts = reports.filter(report => report.provider === provider);
	if (accounts.length === 0) return undefined;
	let soonest: number | undefined;
	for (const { resetAt } of accounts) {
		if (resetAt === undefined || resetAt <= now) return undefined;
		soonest = soonest === undefined ? resetAt : Math.min(soonest, resetAt);
	}
	return soonest;
}
