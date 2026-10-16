import type { RpcAsyncJobItem, RpcJobsResult } from "../../shared/rpc-types";
import { TabPoll, useTabPoll } from "./use-tab-poll";

/** How often stock's background jobs are re-read while the page is visible. */
const JOBS_POLL_MS = 3000;
const NO_JOBS: RpcAsyncJobItem[] = [];

const jobsPoll = new TabPoll<RpcAsyncJobItem[]>(NO_JOBS, (rpc, publish) => {
	let cancelled = false;
	let pending = false;
	const refresh = async () => {
		const client = rpc();
		if (pending || !client || document.visibilityState === "hidden") return;
		pending = true;
		try {
			const response = await client.getJobs();
			if (cancelled || !response.success) return;
			const running = (response.data as RpcJobsResult).jobs.filter(
				job => job.type !== "task" && job.status === "running",
			);
			publish(current => (sameJobs(current, running) ? current : running.length === 0 ? NO_JOBS : running));
		} catch {
			// Keep what is shown.
		} finally {
			pending = false;
		}
	};
	void refresh();
	const poll = window.setInterval(() => void refresh(), JOBS_POLL_MS);
	document.addEventListener("visibilitychange", refresh);
	return () => {
		cancelled = true;
		window.clearInterval(poll);
		document.removeEventListener("visibilitychange", refresh);
	};
});

/**
 * This session's running background shells and evals (stock `bash`/`eval` jobs; `task` jobs are the
 * subagents, which the subagent store carries), polled through `get_jobs` once per tab however many
 * surfaces show them (the dock's island, the work board). A failed read keeps the last list: no list
 * beats a wrong one, and the Background tasks view reports the error.
 */
export function useBackgroundJobs(): RpcAsyncJobItem[] {
	return useTabPoll(jobsPoll, true);
}

function sameJobs(a: readonly RpcAsyncJobItem[], b: readonly RpcAsyncJobItem[]): boolean {
	return a.length === b.length && a.every((job, index) => job.id === b[index]?.id && job.label === b[index]?.label);
}
