import { useCallback } from "react";
import type { RpcAsyncJobItem, RpcJobRow, RpcJobsResult } from "../../shared/rpc-types";
import { isLiveSubagentStatus } from "../components/panels/subagent-graph";
import { type TabRpc, useTabRpc } from "../lib/tab-rpc";
import { onSessionRuntimesChange, sessionRuntime } from "../stores/session-runtime-context";
import type { SubagentsStore } from "../stores/subagents";
import type { TodoStore } from "../stores/todo";
import { TabPoll, useTabPoll, useTabPollKey } from "./use-tab-poll";

/** How often stock's background jobs are re-read while the page is visible. */
const JOBS_POLL_MS = 3000;
const NO_JOBS: RpcAsyncJobItem[] = [];

/** A tab's background jobs as every surface showing them sees them. */
export interface JobsFeed {
	/** Stock's last `get_jobs` tree, rows in display order (the session's jobs, each subagent's nested under it); `null` until the first read lands. */
	rows: RpcJobRow[] | null;
	/**
	 * The running shells and evals of `rows`, the subagents' own included (`task` jobs are the subagents, which the
	 * subagent store carries): the same array while their ids and labels hold.
	 */
	running: RpcAsyncJobItem[];
	/** When the last read landed. */
	updatedAt: number | null;
	/** Why the latest read failed; `null` once one succeeds. A failed read keeps the jobs: no list beats a wrong one. */
	error: string | null;
}

type JobsRead = { ok: true; rows: RpcJobRow[]; running: RpcAsyncJobItem[] } | { ok: false; error: string };

const NO_FEED: JobsFeed = { rows: null, running: NO_JOBS, updatedAt: null, error: null };

async function readJobs(rpc: TabRpc): Promise<JobsRead> {
	try {
		const response = await rpc.getJobs();
		if (!response.success) return { ok: false, error: response.error };
		const { rows } = response.data as RpcJobsResult;
		const running = rows.flatMap(row =>
			row.kind === "job" && row.job.type !== "task" && row.job.status === "running" ? [row.job] : [],
		);
		return { ok: true, rows, running };
	} catch (cause) {
		return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

function shown(feed: JobsFeed, read: JobsRead): JobsFeed {
	if (!read.ok) return read.error === feed.error ? feed : { ...feed, error: read.error };
	const { running } = read;
	return {
		rows: read.rows,
		running: sameJobs(feed.running, running) ? feed.running : running.length === 0 ? NO_JOBS : running,
		updatedAt: Date.now(),
		error: null,
	};
}

/**
 * Whether a job can appear in a tab's tree that the last read found empty: only a tool call adds one (stock's
 * AsyncJobManager), so only while the tab's turn runs or one of its subagents is live. A tab without its runtime yet
 * counts as at work.
 */
function atWork(tabId: string): boolean {
	const runtime = sessionRuntime(tabId);
	const todo = runtime?.stores.get("todo")?.getState() as TodoStore | undefined;
	const agents = runtime?.stores.get("subagents")?.getState() as SubagentsStore | undefined;
	if (!todo || !agents) return true;
	if (todo.turnActive) return true;
	for (const agent of agents.subagents.values()) if (isLiveSubagentStatus(agent.status)) return true;
	return false;
}

/**
 * Read every 3 s while the jobs can change without a tool call: the last read listed jobs (a running one moves on and
 * ends; stock evicts a finished one 5 min after it ends) or failed, or the tab is at work. A tab with an empty tree
 * and nothing running reads nothing (it read 20 times a minute per tab shown, idle or not); the tab stopping work
 * reads once more, for a job started in its last seconds. The feed has no scope, so its key is the tab id.
 */
const jobsPoll = new TabPoll<JobsFeed>(NO_FEED, (rpc, publish, tabId) => {
	let cancelled = false;
	let pending = false;
	/** The tab stopped work while a read was out: that read may predate its last job, so one more follows it. */
	let again = false;
	/** The last read listed jobs, or failed, or none landed yet. */
	let listed = true;
	const refresh = async () => {
		const client = rpc();
		if (pending || !client || document.visibilityState === "hidden") return;
		pending = true;
		const read = await readJobs(client);
		pending = false;
		listed = !read.ok || read.rows.length > 0;
		if (cancelled) return;
		publish(feed => shown(feed, read));
		if (again) {
			again = false;
			void refresh();
		}
	};
	void refresh();
	const poll = window.setInterval(() => {
		if (listed || atWork(tabId)) void refresh();
	}, JOBS_POLL_MS);
	document.addEventListener("visibilitychange", refresh);
	let working = atWork(tabId);
	const follow = () => {
		const now = atWork(tabId);
		if (working && !now) {
			if (pending) again = true;
			else void refresh();
		}
		working = now;
	};
	// The tab's runtime is replaced when its session changes: follow the current one's turn and subagents.
	let unfollow: Array<() => void> = [];
	const attach = () => {
		for (const stop of unfollow) stop();
		const runtime = sessionRuntime(tabId);
		unfollow = (["todo", "subagents"] as const).flatMap(name => {
			const store = runtime?.stores.get(name);
			return store ? [store.subscribe(follow)] : [];
		});
		follow();
	};
	attach();
	const detach = onSessionRuntimesChange(attach);
	return {
		stop: () => {
			cancelled = true;
			window.clearInterval(poll);
			document.removeEventListener("visibilitychange", refresh);
			detach();
			for (const stop of unfollow) stop();
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
