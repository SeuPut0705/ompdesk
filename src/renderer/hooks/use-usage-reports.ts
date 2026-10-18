import { useCallback, useEffect, useMemo } from "react";
import type { UsageReport } from "../../shared/rpc-types";
import { snapshotNs, snapshots } from "../lib/snapshot-cache";
import { type TabRpc, useTabRpc } from "../lib/tab-rpc";
import { readUsageReports, type UsageRead, watchUsage } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
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
	const key = useTabPollKey();
	const device = useTabsStore(state => state.tabs.find(tab => tab.id === key)?.device);
	// Until the first read of this run lands, the last run's reports stand in (their age is in `windows`' reset
	// times, which `resetText` reads against now); the read replaces them in place.
	const seed = useMemo(() => lastKnownUsage(device), [device]);
	const shown = useTabPoll(usagePoll, ready && active, feed =>
		select(feed.reports === null && seed ? seededFeed(feed, seed) : feed),
	);
	// The reports themselves, for the snapshot write below.
	const live = useTabPoll(usagePoll, false, feed => feed.reports);
	useEffect(() => {
		if (live) rememberUsage(device, live);
	}, [live, device]);
	return shown;
}

const USAGE_WRITE_DELAY_MS = 1500;
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function lastKnownUsage(device: string | undefined): UsageReport[] | null {
	const hit = snapshots().read<UsageReport[]>("usage", snapshotNs(device), "reports");
	return hit && Array.isArray(hit.value) ? hit.value : null;
}

/** One quiet write per device, however many surfaces show the same reports. */
function rememberUsage(device: string | undefined, reports: UsageReport[]): void {
	const ns = snapshotNs(device);
	clearTimeout(writeTimers.get(ns));
	writeTimers.set(
		ns,
		setTimeout(() => snapshots().write("usage", ns, "reports", reports), USAGE_WRITE_DELAY_MS),
	);
}

const seededFeeds = new WeakMap<UsageFeed, Map<UsageReport[], UsageFeed>>();

/** The feed with the seed as its reports, one object per (feed, seed) so a selector reading it stays stable. */
function seededFeed(feed: UsageFeed, seed: UsageReport[]): UsageFeed {
	const bySeed = seededFeeds.get(feed) ?? new Map<UsageReport[], UsageFeed>();
	seededFeeds.set(feed, bySeed);
	const seeded = bySeed.get(seed) ?? { ...feed, reports: seed };
	bySeed.set(seed, seeded);
	return seeded;
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
