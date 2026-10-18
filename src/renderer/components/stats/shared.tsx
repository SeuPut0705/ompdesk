/**
 * Shared building blocks for the Insights › Stats (all sessions) sections:
 * range ids, a frame with loading/error/empty states, metric cards, a data
 * table, a chart container, and section headings.
 */

import type { ReactNode } from "react";
import { inlineFailure } from "../../lib/error-detail";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { AsyncSection } from "../common";

export const STATS_RANGES = ["1h", "24h", "7d", "30d", "90d", "all"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

/** Stock pi-ai `StopReason` ids with a label of their own. */
const STOP_REASON_KEY: Record<string, string> = {
	stop: "stats.stopReason.stop",
	length: "stats.stopReason.length",
	toolUse: "stats.stopReason.toolUse",
	error: "stats.stopReason.error",
	aborted: "stats.stopReason.aborted",
};

/** A request's stop reason in words; an id a newer omp adds shows as is. */
export function stopReasonLabel(
	t: (key: string) => string,
	row: { stopReason: string; errorMessage: string | null },
): string {
	const reason = row.stopReason || (row.errorMessage ? "error" : "stop");
	return Object.hasOwn(STOP_REASON_KEY, reason) ? t(STOP_REASON_KEY[reason]) : reason;
}

export function RouteFrame({
	loading,
	hasData = false,
	error,
	serverDown = false,
	empty,
	onRetry,
	children,
}: {
	loading: boolean;
	hasData?: boolean;
	error: string | null;
	/** `error` is main's localized sentence for a stats server that isn't answering. */
	serverDown?: boolean;
	empty?: boolean;
	onRetry: () => void;
	children: ReactNode;
}) {
	const t = useT();
	return (
		<AsyncSection
			empty={empty}
			emptyLabel={t("stats.emptyRange")}
			error={error}
			errorTitle={serverDown ? t("stats.serverDown") : inlineFailure(error, t("stats.unavailable")).message}
			errorDescription={
				serverDown && error ? <span className="text-sc-sm text-(--sc-text-muted)">{error}</span> : undefined
			}
			hasData={hasData}
			loading={loading}
			loadingLabel={t("stats.loading")}
			onRetry={onRetry}
			retryLabel={t("common.retry")}
			staleLabel={t("stats.stale")}
		>
			{children}
		</AsyncSection>
	);
}

const TONE_CLASS = {
	default: "text-(--sc-text)",
	accent: "text-(--sc-accent)",
	success: "text-(--sc-success)",
	warning: "text-(--sc-warning)",
	error: "text-(--sc-danger)",
} as const;

/** "0", "$0", "0%", "—": a figure with nothing in it yet reads quieter than a real one. */
const EMPTY_FIGURE = /^(?:—|\$?0(?:\.0+)?%?)$/;

export function MetricCard({
	label,
	value,
	sub,
	tone = "default",
}: {
	label: string;
	value: string;
	sub?: string;
	tone?: keyof typeof TONE_CLASS;
}) {
	const empty = EMPTY_FIGURE.test(value);
	return (
		<div className="omp-metric-card flex min-w-0 flex-col gap-1 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) px-4 py-3">
			<div className="truncate text-sc-xs text-(--sc-text-muted)" title={label}>
				{label}
			</div>
			<div
				className={cx(
					"truncate text-sc-2xl font-semibold tracking-(--sc-tracking-tight) tabular-nums",
					empty ? "text-(--sc-text-subtle)" : TONE_CLASS[tone],
				)}
				title={value}
			>
				{value}
			</div>
			{/* The detail wraps: a clipped "0 from you · 0 rep…" hides the figure it explains. */}
			{sub && <div className="text-sc-xs break-words text-(--sc-text-muted)">{sub}</div>}
		</div>
	);
}

/** Grid for MetricCards: as many ≥9rem columns as the page's own width holds (not the window's). */
export function MetricGrid({ children }: { children: ReactNode }) {
	return <div className="omp-metric-grid grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">{children}</div>;
}

export interface StatColumn<T> {
	key: string;
	label: string;
	align?: "left" | "right";
	render: (row: T) => ReactNode;
}

export function StatTable<T>({
	columns,
	rows,
	keyFor,
	onRowClick,
}: {
	columns: StatColumn<T>[];
	rows: T[];
	keyFor: (row: T) => string;
	/** Makes rows clickable (e.g. opening a detail sheet). */
	onRowClick?: (row: T) => void;
}) {
	return (
		<div className="overflow-x-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle)">
			<table className="w-full border-collapse text-sc-sm text-(--sc-text-secondary)">
				<thead>
					<tr className="border-b border-(--sc-divider)">
						{columns.map(column => (
							<th
								className={cx(
									"px-3 py-2 text-sc-xs font-medium whitespace-nowrap text-(--sc-text-muted)",
									column.align === "right" ? "text-right" : "text-left",
								)}
								key={column.key}
								scope="col"
							>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map(row => (
						<tr
							className={cx(
								"border-b border-(--sc-divider) last:border-b-0",
								onRowClick &&
									"cursor-pointer hover:bg-(--sc-hover) focus-visible:bg-(--sc-selected) active:bg-(--sc-pressed)",
							)}
							key={keyFor(row)}
							onClick={onRowClick ? () => onRowClick(row) : undefined}
							tabIndex={onRowClick ? 0 : undefined}
							onKeyDown={
								onRowClick
									? event => {
											if (isImeKeyEvent(event)) return;
											if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												onRowClick(row);
											}
										}
									: undefined
							}
						>
							{columns.map(column => (
								<td
									className={cx(
										"px-3 py-3 align-top",
										column.align === "right" && "text-right whitespace-nowrap tabular-nums",
									)}
									key={column.key}
								>
									{column.render(row)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** Bordered chart container; `height` is the canvas height in px (charts need a fixed box). */
export function ChartBox({ height = 260, children }: { height?: number; children: ReactNode }) {
	return (
		<div className="rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-4">
			<div className="relative w-full" style={{ height }}>
				{children}
			</div>
		</div>
	);
}

export function SectionTitle({ children }: { children: ReactNode }) {
	return <h3 className="mt-8 mb-3 text-sc-md font-semibold text-(--sc-text) first:mt-0">{children}</h3>;
}
