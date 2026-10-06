import { useEffect, useState } from "react";
import type { RpcAsyncJobItem, RpcJobsResult } from "../../../shared/rpc-types";
import { AnsiText } from "../../lib/ansi";
import { formatClock, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import { useTabRpc } from "../../lib/tab-rpc";
import { useUiStore } from "../../stores/ui";
import { Badge, Modal, Spinner } from "../common";

type JobStatusVariant = "success" | "default" | "error" | "warning";

const STATUS_VARIANT: Record<RpcAsyncJobItem["status"], JobStatusVariant> = {
	running: "success",
	completed: "default",
	failed: "error",
	cancelled: "warning",
};

/**
 * Native /jobs: async background jobs owned by the session — running first,
 * then recent, exactly the snapshot ordering the agent sends. Rows render
 * the job object's own fields (id, type, status, elapsed time, label).
 */
export function JobsDialog() {
	const t = useT();
	const rpc = useTabRpc();
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const [now, setNow] = useState(Date.now);
	const open = useUiStore(state => state.jobsOpen);
	const close = useUiStore(state => state.closeJobs);
	const [jobs, setJobs] = useState<RpcAsyncJobItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
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
				if (!cancelled) setError(String(cause));
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
	}, [open, rpc]);

	const running = jobs.filter(job => job.status === "running" || job.cancellationPending);
	const recent = jobs.filter(job => job.status !== "running" && !job.cancellationPending);

	const renderJob = (job: RpcAsyncJobItem) => (
		<div className="px-3 py-2" key={job.id}>
			<div className="flex items-center gap-2">
				<span className="font-mono text-xs text-(--omp-dim)">[{job.id}]</span>
				<span className="text-xs font-medium text-(--omp-text)">{t(`jobs.type.${job.type}`)}</span>
				<Badge dot pulse={job.status === "running"} variant={STATUS_VARIANT[job.status]}>
					{t(job.cancellationPending ? "jobs.cancelling" : `jobs.status.${job.status}`)}
				</Badge>
				<span className="ml-auto shrink-0 text-xs tabular-nums text-(--omp-dim)">
					{job.status === "running" || job.cancellationPending || job.endedAt !== undefined
						? formatDuration(Math.max(0, (job.endedAt ?? now) - job.startTime))
						: t("jobs.durationUnavailable")}
				</span>
			</div>
			<div className="mt-0.5 break-words whitespace-pre-wrap text-xs text-(--omp-dim)">{job.label}</div>
			{(job.resultPreview || job.errorPreview) && (
				<details className="mt-2 text-omp-sm">
					<summary className="cursor-pointer">{t("jobs.result")}</summary>
					<pre className={`${PREVIEW_SCROLL_LG} whitespace-pre-wrap break-words`}>
						<AnsiText text={job.errorPreview ?? job.resultPreview ?? ""} />
					</pre>
					{job.previewTruncated && <p>{t("diffPanel.previewLimited")}</p>}
				</details>
			)}
		</div>
	);

	return (
		<Modal onClose={close} open={open} size="lg" title={t("jobs.title")}>
			{updatedAt && (
				<p className="mb-2 text-omp-xs text-(--omp-dim)">{t("jobs.updated", { time: formatClock(updatedAt) })}</p>
			)}
			{error && (
				<p role="alert" className="text-omp-sm text-(--omp-error)">
					{t("jobs.error")}: {error}
				</p>
			)}
			{loading ? (
				<div className="flex items-center justify-center gap-2 py-8 text-sm text-(--omp-dim)">
					<Spinner size="sm" /> {t("jobs.loading")}
				</div>
			) : jobs.length === 0 && !error ? (
				<div className="space-y-2 py-4">
					<div className="text-sm text-(--omp-text)">{t("jobs.empty")}</div>
					<div className="text-xs text-(--omp-dim)">{t("jobs.emptyHint")}</div>
				</div>
			) : (
				<div className="space-y-4">
					{running.length > 0 ? (
						<section>
							<div className="mb-1.5 flex items-center gap-2">
								<span className="text-xs font-semibold text-(--omp-text)">{t("jobs.running")}</span>
								<Badge variant="muted">{running.length}</Badge>
							</div>
							<div className="divide-y divide-(--omp-border-muted) rounded-lg border border-(--omp-border-muted)">
								{running.map(renderJob)}
							</div>
						</section>
					) : null}
					{recent.length > 0 ? (
						<section>
							<div className="mb-1.5 flex items-center gap-2">
								<span className="text-xs font-semibold text-(--omp-text)">{t("jobs.recentLimited")}</span>
								<Badge variant="muted">{recent.length}</Badge>
							</div>
							<div className="divide-y divide-(--omp-border-muted) rounded-lg border border-(--omp-border-muted)">
								{recent.map(renderJob)}
							</div>
						</section>
					) : null}
				</div>
			)}
		</Modal>
	);
}
