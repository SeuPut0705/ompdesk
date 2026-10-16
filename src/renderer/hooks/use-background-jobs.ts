import { useCallback } from "react";
import type { RpcAsyncJobItem, RpcJobsResult } from "../../shared/rpc-types";
import { type TabRpc, useTabRpc } from "../lib/tab-rpc";
import { TabPoll, useTabPoll, useTabPollKey } from "./use-tab-poll";

/** How often stock's background jobs are re-read while the page is visible. */
const JOBS_POLL_MS = 3000;
const NO_JOBS: RpcAsyncJobItem[] = [];

/** A tab's background jobs as every surface showing them sees them. */
export interface JobsFeed {
	/** Stock's last `get_jobs` snapshot, running first, then recent; `null` until the first read lands. */
	jobs: RpcAsyncJobItem[] | null;
	/**
	 * The running shells and evals of `jobs` (`task` jobs are the subagents, which the subagent store carries):
	 * the same array while their ids and labels hold.
	 */
	running: RpcAsyncJobItem[];
	/** When the last read landed. */
	updatedAt: number | null;
	/** Why the latest read failed; `null` once one succeeds. A failed read keeps the jobs: no list beats a wrong one. */
	error: string | null;
}

type JobsRead = { ok: true; jobs: RpcAsyncJobItem[]; running: RpcAsyncJobItem[] } | { ok: false; error: string };

const NO_FEED: JobsFeed = { jobs: null, running: NO_JOBS, updatedAt: null, error: null };

async function readJobs(rpc: TabRpc): Promise<JobsRead> {
	try {
		const response = await rpc.getJobs();
		if (!response.success) return { ok: false, error: response.error };
		const { jobs } = response.data as RpcJobsResult;
		return { ok: true, jobs, running: jobs.filter(job => job.type !== "task" && job.status === "running") };
	} catch (cause) {
		return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

function shown(feed: JobsFeed, read: JobsRead): JobsFeed {
	if (!read.ok) return read.error === feed.error ? feed : { ...feed, error: read.error };
	const { running } = read;
	return {
		jobs: read.jobs,
		running: sameJobs(feed.running, running) ? feed.running : running.length === 0 ? NO_JOBS : running,
		updatedAt: Date.now(),
		error: null,
	};
}

const jobsPoll = new TabPoll<JobsFeed>(NO_FEED, (rpc, publish) => {
	let cancelled = false;
	let pending = false;
	const refresh = async () => {
		const client = rpc();
		if (pending || !client || document.visibilityState === "hidden") return;
		pending = true;
		const read = await readJobs(client);
		pending = false;
		if (!cancelled) publish(feed => shown(feed, read));
	};
	void refresh();
	const poll = window.setInterval(() => void refresh(), JOBS_POLL_MS);
	document.addEventListener("visibilitychange", refresh);
	return {
		read: () => void refresh(),
		stop: () => {
			cancelled = true;
			window.clearInterval(poll);
			document.removeEventListener("visibilitychange", refresh);
		},
	};
});

/**
 * `select` of this session's background jobs (stock `get_jobs`), polled once per tab however many surfaces
 * show them (the dock's island, the composer, the work board, the Background tasks view); a surface re-renders
 * only when what it selects changes.
 */
export function useJobs<S>(select: (feed: JobsFeed) => S): S {
	return useTabPoll(jobsPoll, true, select);
}

/** This session's running background shells and evals ({@link JobsFeed.running}). */
export function useBackgroundJobs(): RpcAsyncJobItem[] {
	return useJobs(feed => feed.running);
}

/** One read of this tab's jobs outside the poll (after a cancel, a retry), shown by every surface of the tab. */
export function useJobsRead(): () => Promise<void> {
	const rpc = useTabRpc();
	const key = useTabPollKey();
	return useCallback(async () => {
		const read = await readJobs(rpc);
		jobsPoll.publish(key, feed => shown(feed, read));
	}, [rpc, key]);
}

function sameJobs(a: readonly RpcAsyncJobItem[], b: readonly RpcAsyncJobItem[]): boolean {
	return a.length === b.length && a.every((job, index) => job.id === b[index]?.id && job.label === b[index]?.label);
}
