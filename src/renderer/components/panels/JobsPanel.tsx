/**
 * Side panel › Jobs: async background jobs owned by the session (native
 * /jobs) — running first, then recent, exactly the snapshot ordering the
 * agent sends. Reads through the tab's one jobs poll
 * (hooks/use-background-jobs.ts, shared with the dock and the work board);
 * the shared one-second clock keeps running durations live.
 */

import { ChevronRight, Hourglass, RotateCw } from "lucide-react";
import { useId, useState } from "react";
import type { RpcAsyncJobItem } from "../../../shared/rpc-types";
import { useJobs, useJobsRead } from "../../hooks/use-background-jobs";
import { AnsiText } from "../../lib/ansi";
import { formatClock, formatDuration, formatElapsed } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { useTabRpc } from "../../lib/tab-rpc";
import { toastError } from "../../stores/toast";
import { Badge, type BadgeVariant, Banner, Button, EmptyState, ErrorDetail, SkeletonRows } from "../common";
import { PANEL_ROW_SURFACE, PanelToolbar } from "./PanelChrome";

const STATUS_VARIANT: Record<RpcAsyncJobItem["status"], BadgeVariant> = {
	running: "success",
	completed: "default",
	failed: "error",
	cancelled: "warning",
};

/** Job rows' first visit: the shape of a short list (a name bar per row), nothing turning. */
const JOB_SKELETON_WIDTHS = [58, 72, 46] as const;

export function JobsPanel() {
	const t = useT();
	const rpc = useTabRpc();
	const feed = useJobs(jobsFeed => jobsFeed);
	const readJobs = useJobsRead();
	const [retrying, setRetrying] = useState(false);
	const [cancelling, setCancelling] = useState<string | null>(null);
	const sectionId = useId();
	const { updatedAt, error } = feed;
	const loading = feed.jobs === null && error === null;
	const jobs = feed.jobs ?? [];

	const running = jobs.filter(job => job.status === "running" || job.cancellationPending);
	const recent = jobs.filter(job => job.status !== "running" && !job.cancellationPending);
	const now = useNowTick(running.length > 0);

	const retry = async () => {
		setRetrying(true);
		try {
			await readJobs();
		} finally {
			setRetrying(false);
		}
	};

	const renderJob = (job: RpcAsyncJobItem) => {
		const live = job.status === "running" || job.cancellationPending === true;
		const preview = job.errorPreview ?? job.resultPreview;
		return (
			<li
				className={`${PANEL_ROW_SURFACE} mx-3 mb-2 border border-(--sc-border-subtle) bg-(--sc-surface-1)`}
				data-job-id={job.id}
				key={job.id}
			>
				<div className="flex min-w-0 items-start gap-2">
					<span title={job.label} className="line-clamp-2 min-w-0 flex-1 text-sc-sm break-words text-(--sc-text)">
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
							? live
								? formatElapsed(Math.max(0, now - job.startTime))
								: formatDuration(Math.max(0, (job.endedAt ?? now) - job.startTime))
							: t("jobs.durationUnavailable")}
					</span>
					{job.status === "running" && (
						<Button
							className="ml-auto shrink-0"
							size="sm"
							variant="secondary"
							disabled={job.cancellationPending || cancelling === job.id}
							onClick={async () => {
								setCancelling(job.id);
								try {
									const response = await rpc.command({ type: "cancel_job", jobId: job.id });
									if (!response.success) throw new Error(response.error);
									await readJobs();
								} catch (cause) {
									// A refused cancel is not a failed list: the rows stay, a toast names the action.
									toastError({ title: t("jobs.cancelFailed"), error: cause });
								} finally {
									setCancelling(null);
								}
							}}
						>
							{t("common.cancel")}
						</Button>
					)}
				</div>
				{preview && (
					<details className="group/job mt-1.5" open={live}>
						<summary className="flex min-h-(--sc-control-sm) cursor-pointer list-none items-center gap-1 rounded-(--sc-radius-sm) text-sc-xs text-(--sc-text-muted) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) [&::-webkit-details-marker]:hidden">
							<ChevronRight aria-hidden className="size-3 shrink-0 group-open/job:rotate-90" />
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
					className="flex items-center gap-2 px-3 pt-3 pb-1 text-sc-xs font-medium text-(--sc-text-muted)"
					id={id}
				>
					{title}
					<Badge>{items.length}</Badge>
				</h3>
				<ul>{items.map(renderJob)}</ul>
			</section>
		);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3">
			{error && (
				<Banner
					actions={
						<Button
							icon={<RotateCw />}
							loading={retrying}
							onClick={() => void retry()}
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
					<ErrorDetail error={error} />
				</Banner>
			)}
			{loading ? (
				<SkeletonRows className="px-1 py-2" label={t("jobs.loading")} widths={JOB_SKELETON_WIDTHS} />
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
						<PanelToolbar className="text-sc-xs text-(--sc-text-subtle)">
							{t("jobs.updated", { time: formatClock(updatedAt) })}
						</PanelToolbar>
					)}
					{renderSection(`${sectionId}-running`, t("jobs.running"), running)}
					{renderSection(`${sectionId}-recent`, t("jobs.recentLimited"), recent)}
				</>
			)}
		</div>
	);
}
