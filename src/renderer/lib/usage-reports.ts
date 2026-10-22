/**
 * Live provider quotas for every surface that shows stock's usage reports
 * (Settings › Models & providers accounts and the model table, Stats › Usage,
 * the sidebar usage pin, the work board, the usage-limit notice). They share
 * one poll per tab (`hooks/use-usage-reports.ts`), which re-reads while any of
 * them is on screen:
 *
 * - every {@link USAGE_POLL_MS}, stock's own status-line cadence, through stock's
 *   cached read. Stock decides when to probe the provider (its per-account cache,
 *   5 minutes ±25%, pi-ai `USAGE_REPORT_TTL_MS`), and every model response
 *   refreshes the account that served it from its rate-limit headers in between
 *   (`usage.ingestHeaders`, at most once a minute);
 * - when any tab's turn ends (its headers just moved the in-use account) and when
 *   the window comes back into focus or into view, but no sooner than
 *   {@link USAGE_EVENT_GAP_MS} after the last read: such a read comes when that
 *   gap is over.
 *
 * Why not more often: a read probes every account whose report expired, and a
 * probe that failed waits only a minute (Claude's `/usage`, which rate-limits per
 * address and stays limited for minutes after a 429). Read every 30 s, three
 * Anthropic accounts answered 429 313 times on one Mac in a day (22 Oct 2026).
 *
 * A failed read doubles the wait up to {@link USAGE_BACKOFF_MAX_MS} and holds
 * the focus and turn-end reads until one succeeds again.
 *
 * The explicit refresh (`refresh: true`) is stock's `omp usage invalidate`
 * for each provider holding a report older than a minute: the bridge has
 * stock probe those accounts now and keeps an account's previous report, with
 * its own age, if the new probe fails (resources/gui-bridge/settings.ts).
 */

import { create } from "zustand";
import type { RpcResponse, UsageLimit, UsageReport } from "../../shared/rpc-types";
import { providerBrand } from "../components/settings/providers/provider-marks";
import { accountWindows } from "./usage-windows";

export const USAGE_POLL_MS = 5 * 60_000;
export const USAGE_EVENT_GAP_MS = 60_000;
export const USAGE_BACKOFF_MAX_MS = 20 * 60_000;

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

/** One `get_usage` answer: the reports, or why the read failed. */
export type UsageRead = { ok: true; reports: UsageReport[] } | { ok: false; error: string };

/** The one reader of a `get_usage` response; a success without a `reports` array reads as none. */
export function readUsageReports(response: RpcResponse): UsageRead {
	if (!response.success) return { ok: false, error: response.error };
	const data = response.data;
	return {
		ok: true,
		reports:
			typeof data === "object" && data !== null && "reports" in data && Array.isArray(data.reports)
				? data.reports
				: [],
	};
}

/**
 * The report of the account a provider's quota is shown for: the one this
 * tab's session uses, else the first that names any limit.
 */
export function inUseReport(reports: readonly UsageReport[], provider: string | null | undefined) {
	const own = reports.filter(report => report.provider === provider && report.limits.length > 0);
	return own.find(report => report.active) ?? own[0];
}

/** One provider company's entry in the sidebar and the work board: the account it last used. */
export interface ProviderAccount {
	report: UsageReport;
	/** This tab's session uses the company's provider. */
	inUse: boolean;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * One entry per provider company (Anthropic, OpenAI, …) that reports usage windows (API-key providers have none),
 * each showing the account the company's sessions used last: the report stock marks `active` (this tab's pin), else
 * the one with the latest `lastUsedAt` (stock's response-header stamp, even rotation's ledger), else the first by
 * account. The company this tab's model belongs to comes first and is `inUse`; the others follow by company name.
 */
export function lastUsedAccounts(
	reports: readonly UsageReport[],
	provider: string | null | undefined,
): ProviderAccount[] {
	const byCompany = new Map<string, UsageReport[]>();
	for (const report of reports) {
		if (accountWindows(report.limits).length === 0) continue;
		const company = providerBrand({ id: report.provider, name: report.provider }).company;
		byCompany.set(company, [...(byCompany.get(company) ?? []), report]);
	}
	const current = provider ? providerBrand({ id: provider, name: provider }).company : null;
	return [...byCompany.entries()]
		.map(([company, own]) => {
			const ordered = [...own].sort(
				(a, b) => collator.compare(a.account ?? "", b.account ?? "") || collator.compare(a.provider, b.provider),
			);
			let last = ordered[0] as UsageReport;
			for (const report of ordered) {
				if ((report.lastUsedAt ?? -1) > (last.lastUsedAt ?? -1)) last = report;
			}
			const pinned = ordered.find(report => report.active && report.provider === provider);
			return {
				company,
				report: pinned ?? ordered.find(report => report.active) ?? last,
				inUse: company === current,
			};
		})
		.sort((a, b) => Number(b.inUse) - Number(a.inUse) || collator.compare(a.company, b.company))
		.map(({ report, inUse }) => ({ report, inUse }));
}

/**
 * The most-consumed limit in a provider report — the one that gates usage
 * first. The bridge normalizes `usedFraction` with stock `resolveUsedFraction`.
 */
export function tightestLimit(report: Pick<UsageReport, "limits">): { limit: UsageLimit; fraction: number } | null {
	let best: { limit: UsageLimit; fraction: number } | null = null;
	for (const limit of report.limits) {
		const fraction = limit.usedFraction;
		if (fraction === undefined) continue;
		if (!best || fraction > best.fraction) best = { limit, fraction };
	}
	return best;
}

/**
 * Re-reads quotas until the returned stop runs (see the module comment). `read` resolves to whether the
 * read succeeded; the caller does its own first read.
 */
export function watchUsage(read: () => Promise<boolean>): () => void {
	let timer: number | undefined;
	let failures = 0;
	let inFlight = false;
	let disposed = false;
	let lastRead = Number.NEGATIVE_INFINITY;
	const schedule = () => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => void run(), usagePollDelay(failures));
	};
	const run = async () => {
		if (disposed || inFlight) return;
		// Hidden: nothing to update; the read on return to view catches up.
		if (document.visibilityState === "hidden") return schedule();
		inFlight = true;
		lastRead = Date.now();
		window.clearTimeout(timer);
		let ok = false;
		try {
			ok = await read();
		} catch {
			ok = false;
		}
		inFlight = false;
		if (disposed) return;
		failures = ok ? 0 : failures + 1;
		schedule();
	};
	/** Focus, back in view, a turn's end: read now, or once the gap since the last read is over, unless backing off. */
	const event = () => {
		if (failures !== 0 || document.visibilityState === "hidden") return;
		const wait = lastRead + USAGE_EVENT_GAP_MS - Date.now();
		if (wait <= 0) {
			void run();
			return;
		}
		window.clearTimeout(timer);
		timer = window.setTimeout(() => void run(), wait);
	};
	window.addEventListener("focus", event);
	document.addEventListener("visibilitychange", event);
	const unsubscribe = useUsageSignal.subscribe((state, previous) => {
		if (state.turnEnds !== previous.turnEnds) event();
	});
	schedule();
	return () => {
		disposed = true;
		window.clearTimeout(timer);
		window.removeEventListener("focus", event);
		document.removeEventListener("visibilitychange", event);
		unsubscribe();
	};
}
