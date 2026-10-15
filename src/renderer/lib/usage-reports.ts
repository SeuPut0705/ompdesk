/**
 * Live provider quotas for every surface that shows stock's usage reports
 * (Settings › Models & providers accounts and the model table, Stats › Usage,
 * the sidebar usage pin, the usage-limit notice). Each one re-reads while it
 * is on screen:
 *
 * - every {@link USAGE_POLL_MS} through stock's cached read. Stock decides when
 *   to probe the provider (its per-account cache, 5 minutes ±25%, pi-ai
 *   `USAGE_REPORT_TTL_MS`), and every model response refreshes the account that
 *   served it from its rate-limit headers in between (`usage.ingestHeaders`,
 *   at most once a minute), so a poll costs a cache read, not a provider call;
 * - when any tab's turn ends (its headers just moved the in-use account);
 * - when the window comes back into focus or into view.
 *
 * A failed read doubles the wait up to {@link USAGE_BACKOFF_MAX_MS} and holds
 * the focus and turn-end reads until one succeeds again.
 *
 * The explicit refresh (`refresh: true`) is stock's `omp usage invalidate`
 * for each provider holding a report older than a minute: the bridge has
 * stock probe those accounts now and keeps an account's previous report, with
 * its own age, if the new probe fails (resources/gui-bridge/settings.ts).
 */

import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { UsageLimit, UsageReport } from "../../shared/rpc-types";

export const USAGE_POLL_MS = 30_000;
export const USAGE_BACKOFF_MAX_MS = 5 * 60_000;

/** Wait before the next poll after `failures` reads failed in a row. */
export function usagePollDelay(failures: number): number {
	return Math.min(USAGE_POLL_MS * 2 ** Math.max(0, failures), USAGE_BACKOFF_MAX_MS);
}

interface UsageSignalState {
	/** Bumped whenever any tab's turn ends. */
	turnEnds: number;
	turnEnded: () => void;
	reset: () => void;
}

export const useUsageSignal = create<UsageSignalState>()(set => ({
	turnEnds: 0,
	turnEnded: () => set(state => ({ turnEnds: state.turnEnds + 1 })),
	reset: () => set({ turnEnds: 0 }),
}));

/**
 * The report of the account a provider's quota is shown for: the one this
 * tab's session uses, else the first that names any limit.
 */
export function inUseReport(reports: readonly UsageReport[], provider: string | null | undefined) {
	const own = reports.filter(report => report.provider === provider && report.limits.length > 0);
	return own.find(report => report.active) ?? own[0];
}

/**
 * The most-consumed limit in a provider report — the one that gates usage
 * first. The bridge normalizes `usedFraction` with stock `resolveUsedFraction`.
 */
export function tightestLimit(report: UsageReport): { limit: UsageLimit; fraction: number } | null {
	let best: { limit: UsageLimit; fraction: number } | null = null;
	for (const limit of report.limits) {
		const fraction = limit.usedFraction;
		if (fraction === undefined) continue;
		if (!best || fraction > best.fraction) best = { limit, fraction };
	}
	return best;
}

/**
 * Re-reads quotas while `active` (see the module comment). `read` resolves to
 * whether the read succeeded; the surface does its own first read.
 */
export function useLiveUsage(read: () => Promise<boolean>, active: boolean): void {
	const readRef = useRef(read);
	readRef.current = read;
	const nudge = useRef<(() => void) | null>(null);

	useEffect(() => {
		if (!active) return;
		let timer: number | undefined;
		let failures = 0;
		let inFlight = false;
		let disposed = false;
		const schedule = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => void run(), usagePollDelay(failures));
		};
		const run = async () => {
			if (disposed || inFlight) return;
			// Hidden: nothing to update; the read on return to view catches up.
			if (document.visibilityState === "hidden") return schedule();
			inFlight = true;
			window.clearTimeout(timer);
			let ok = false;
			try {
				ok = await readRef.current();
			} catch {
				ok = false;
			}
			inFlight = false;
			if (disposed) return;
			failures = ok ? 0 : failures + 1;
			schedule();
		};
		/** Focus, back in view, a turn's end: read now unless backing off. */
		const event = () => {
			if (failures === 0 && document.visibilityState !== "hidden") void run();
		};
		nudge.current = event;
		window.addEventListener("focus", event);
		document.addEventListener("visibilitychange", event);
		schedule();
		return () => {
			disposed = true;
			nudge.current = null;
			window.clearTimeout(timer);
			window.removeEventListener("focus", event);
			document.removeEventListener("visibilitychange", event);
		};
	}, [active]);

	const turnEnds = useUsageSignal(state => state.turnEnds);
	const seen = useRef(turnEnds);
	useEffect(() => {
		if (seen.current === turnEnds) return;
		seen.current = turnEnds;
		nudge.current?.();
	}, [turnEnds]);
}
