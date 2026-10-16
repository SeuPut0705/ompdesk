import { useCallback } from "react";
import type { UsageReport } from "../../shared/rpc-types";
import { type TabRpc, useTabRpc } from "../lib/tab-rpc";
import { readUsageReports, type UsageRead, watchUsage } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";
import { TabPoll, useTabPoll, useTabPollKey } from "./use-tab-poll";

/** A tab's usage as every surface showing it sees it. */
export interface UsageFeed {
	/**
	 * `get_usage`'s reports: one per provider account, the one its session uses marked `active`. `null` until
	 * the first read lands; a failed read keeps them.
	 */
	reports: UsageReport[] | null;
	/** Why the latest read failed; `null` once one succeeds. */
	error: string | null;
	/**
	 * Counts the reads of the poll's own schedule (interval, focus, back in view, a turn's end), never a
	 * surface's mount read: a surface that re-reads its own quota data on that schedule follows it.
	 */
	polls: number;
}

const NO_USAGE: UsageFeed = { reports: null, error: null, polls: 0 };

async function readUsage(rpc: TabRpc, refresh = false): Promise<UsageRead> {
	try {
		return readUsageReports(await rpc.getUsage(refresh));
	} catch (cause) {
		return { ok: false, error: String(cause) };
	}
}

function shown(feed: UsageFeed, read: UsageRead): UsageFeed {
	if (read.ok) return { ...feed, reports: read.reports, error: null };
	return read.error === feed.error ? feed : { ...feed, error: read.error };
}

const usagePoll = new TabPoll<UsageFeed>(NO_USAGE, (rpc, publish) => {
	let latest = 0;
	let stopped = false;
	const load = async (scheduled: boolean): Promise<boolean> => {
		const client = rpc();
		if (!client) return false;
		const call = ++latest;
		const read = await readUsage(client);
		if (stopped) return false;
		// A newer read supersedes this one's answer, not its place in the schedule.
		const current = call === latest;
		publish(feed => {
			const next = current ? shown(feed, read) : feed;
			return scheduled ? { ...next, polls: feed.polls + 1 } : next;
		});
		return current && read.ok;
	};
	void load(false);
	const unwatch = watchUsage(() => load(true));
	return {
		read: () => void load(false),
		stop: () => {
			stopped = true;
			unwatch();
		},
	};
});

/**
 * `select` of this tab's usage, read when each surface showing it mounts and kept current by `watchUsage`
 * alone: one poll per tab however many surfaces show it (the sidebar's usage lines, the work board's account
 * row, Stats › Usage, the Settings model tables and accounts, the usage-limit notice). Polls while the tab's omp
 * is ready and `active`; a surface re-renders only when what it selects changes.
 */
export function useUsage<S>(select: (feed: UsageFeed) => S, active = true): S {
	const ready = useSessionStore(s => s.status) === "ready";
	return useTabPoll(usagePoll, ready && active, select);
}

/** This tab's usage reports ({@link UsageFeed.reports}). */
export function useUsageReports(active = true): UsageReport[] | null {
	return useUsage(feed => feed.reports, active);
}

/**
 * One read of this tab's usage outside the poll, shown by every surface of the tab. `refresh` has stock probe
 * every provider whose report is a minute old first (lib/usage-reports.ts).
 */
export function useUsageRead(): (refresh?: boolean) => Promise<UsageRead> {
	const rpc = useTabRpc();
	const key = useTabPollKey();
	return useCallback(
		async (refresh?: boolean) => {
			const read = await readUsage(rpc, refresh);
			usagePoll.publish(key, feed => shown(feed, read));
			return read;
		},
		[rpc, key],
	);
}
