/**
 * Side panel › Jobs: async background jobs owned by the session (native
 * /jobs) — running first, then recent, exactly the snapshot ordering the
 * agent sends. Polls every 2s while mounted (and on becoming visible again);
 * a 1s clock keeps running durations live.
 */

import { Hourglass, RotateCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { RpcAsyncJobItem, RpcJobsResult } from "../../../shared/rpc-types";
import { AnsiText } from "../../lib/ansi";
import { formatClock, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { useTabRpc } from "../../lib/tab-rpc";
import { Badge, type BadgeVariant, Banner, Button, EmptyState, Spinner } from "../common";

const STATUS_VARIANT: Record<RpcAsyncJobItem["status"], BadgeVariant> = {
	running: "success",
	completed: "default",
	failed: "error",
	cancelled: "warning",
};

export function JobsPanel() {
	const t = useT();
	const rpc = useTabRpc();
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const [now, setNow] = useState(Date.now);
	const [jobs, setJobs] = useState<RpcAsyncJobItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const sectionId = useId();

	/* The retry button's bump is the only reason this effect re-runs on `attempt`. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry re-polls by bump
	useEffect(() => {
		let cancelled = false;
		let pending = false;
		setJobs([]);
		setUpdatedAt(null);
		setError(null);
		setLoading(true);
		const refresh = async () => {
			if (pending || document.visibilityState === "hidden") return;
			pending = true;
			try {
				const response = await rpc.getJobs();
				if (cancelled) return;
				if (!response.success) throw new Error(response.error);
				setJobs((response.data as RpcJobsResult).jobs);
				setUpdatedAt(Date.now());
				setError(null);
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				pending = false;
				if (!cancelled) setLoading(false);
			}
		};
		void refresh();
		const poll = window.setInterval(() => void refresh(), 2000);
		const clock = window.setInterval(() => setNow(Date.now()), 1000);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			cancelled = true;
			window.clearInterval(poll);
			window.clearInterval(clock);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [attempt, rpc]);

	const running = jobs.filter(job => job.status === "running" || job.cancellationPending);
	const recent = jobs.filter(job => job.status !== "running" && !job.cancellationPending);

	const renderJob = (job: RpcAsyncJobItem) => {
		const live = job.status === "running" || job.cancellationPending === true;
		const preview = job.errorPreview ?? job.resultPreview;
		return (
			<li className="px-3 py-2" data-job-id={job.id} key={job.id}>
				<div className="flex min-w-0 items-start gap-2">
					<span className="line-clamp-2 min-w-0 flex-1 text-sc-md font-medium break-words text-(--sc-text)">
						{job.label}
					</span>
					<Badge dot pulse={job.status === "running"} variant={STATUS_VARIANT[job.status]}>
						{t(job.cancellationPending ? "jobs.cancelling" : `jobs.status.${job.status}`)}
					</Badge>
				</div>
				<div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
					<span className="shrink-0">{t(`jobs.type.${job.type}`)}</span>
					<span aria-hidden>·</span>
					<span className="shrink-0 tabular-nums">
						{live || job.endedAt !== undefined
							? formatDuration(Math.max(0, (job.endedAt ?? now) - job.startTime))
							: t("jobs.durationUnavailable")}
					</span>
					<span aria-hidden>·</span>
					<span className="truncate font-mono text-(--sc-text-subtle)">{job.id}</span>
				</div>
				{preview && (
					<details className="mt-1.5">
						<summary className="cursor-pointer text-sc-xs text-(--sc-text-muted) hover:text-(--sc-text)">
							{t("jobs.result")}
						</summary>
						<pre
							className={`${PREVIEW_SCROLL_LG} mt-1 rounded-(--sc-radius-sm) bg-(--sc-surface-2) p-2 font-mono text-sc-xs whitespace-pre-wrap break-words text-(--sc-text-secondary)`}
						>
							<AnsiText text={preview} />
						</pre>
						{job.previewTruncated && (
							<p className="mt-1 text-sc-xs text-(--sc-text-subtle)">{t("diffPanel.previewLimited")}</p>
						)}
					</details>
				)}
			</li>
		);
	};

	const renderSection = (id: string, title: string, items: RpcAsyncJobItem[]) =>
		items.length > 0 && (
			<section aria-labelledby={id}>
				<h3
					className="flex items-center gap-2 px-3 pt-3 pb-1 text-sc-xs font-semibold tracking-wide text-(--sc-text-muted) uppercase"
					id={id}
				>
					{title}
					<Badge>{items.length}</Badge>
				</h3>
				<ul className="divide-y divide-(--sc-divider)">{items.map(renderJob)}</ul>
			</section>
		);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3">
			{error && (
				<Banner
					actions={
						<Button
							icon={<RotateCw />}
							onClick={() => setAttempt(count => count + 1)}
							size="sm"
							variant="secondary"
						>
							{t("common.retry")}
						</Button>
					}
					className="mx-3 mt-3"
					live
					title={t("jobs.error")}
					variant="danger"
				>
					{error}
				</Banner>
			)}
			{loading ? (
				<div className="flex flex-1 items-center justify-center py-8">
					<Spinner label={t("jobs.loading")} size="sm" />
				</div>
			) : jobs.length === 0 ? (
				!error && (
					<EmptyState
						className="flex-1"
						description={t("jobs.emptyHint")}
						icon={<Hourglass />}
						size="sm"
						title={t("jobs.empty")}
					/>
				)
			) : (
				<>
					{updatedAt && (
						<p className="px-3 pt-2 text-sc-xs text-(--sc-text-subtle)">
							{t("jobs.updated", { time: formatClock(updatedAt) })}
						</p>
					)}
					{renderSection(`${sectionId}-running`, t("jobs.running"), running)}
					{renderSection(`${sectionId}-recent`, t("jobs.recentLimited"), recent)}
				</>
			)}
		</div>
	);
}
