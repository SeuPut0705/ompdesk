import { useEffect, useState } from "react";
import type { RpcAsyncJobItem, RpcJobsResult } from "../../shared/rpc-types";
import { useTabRpc } from "../lib/tab-rpc";

/** How often stock's background jobs are re-read while the page is visible. */
const JOBS_POLL_MS = 3000;
const NO_JOBS: RpcAsyncJobItem[] = [];

/**
 * This session's running background shells and evals (stock `bash`/`eval` jobs; `task` jobs are the
 * subagents, which the subagent store carries), polled through `get_jobs`. A failed read keeps the
 * last list: no list beats a wrong one, and the Background tasks view reports the error.
 */
export function useBackgroundJobs(): RpcAsyncJobItem[] {
	const rpc = useTabRpc();
	const [jobs, setJobs] = useState<RpcAsyncJobItem[]>(NO_JOBS);
	useEffect(() => {
		let cancelled = false;
		let pending = false;
		const refresh = async () => {
			if (pending || document.visibilityState === "hidden") return;
			pending = true;
			try {
				const response = await rpc.getJobs();
				if (cancelled || !response.success) return;
				const running = (response.data as RpcJobsResult).jobs.filter(
					job => job.type !== "task" && job.status === "running",
				);
				setJobs(current => (sameJobs(current, running) ? current : running.length === 0 ? NO_JOBS : running));
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
	}, [rpc]);
	return jobs;
}

function sameJobs(a: readonly RpcAsyncJobItem[], b: readonly RpcAsyncJobItem[]): boolean {
	return a.length === b.length && a.every((job, index) => job.id === b[index]?.id && job.label === b[index]?.label);
}
