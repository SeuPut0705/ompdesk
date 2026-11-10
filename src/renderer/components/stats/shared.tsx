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
import { AsyncSection, Card, SettingInfo } from "../common";

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
		<Card className="omp-metric-card flex min-w-0 flex-col gap-1 px-4 py-3" padding="none">
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
			{/* The detail wraps: a clipped "You 0 · Assist…" hides the figure it explains. */}
			{sub && <div className="text-sc-xs break-words text-(--sc-text-muted)">{sub}</div>}
		</Card>
	);
}

/**
 * Grid for MetricCards: as many ≥9rem columns as the page's own width holds (not the window's). Cards of a row share
 * its height; each row is as tall as its own tallest card, so a row of figures with no detail line stays short instead
 * of borrowing another row's blank line. Where only two columns fit, an odd last card takes the whole row instead of
 * leaving an empty cell.
 */
export function MetricGrid({ children }: { children: ReactNode }) {
	return (
		<div className="omp-metric-grid @container grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 [&>:last-child:nth-child(odd)]:@max-md:col-span-full">
			{children}
		</div>
	);
}

export interface StatColumn<T> {
	key: string;
	label: string;
	align?: "left" | "right";
	/** What the column's figure means (a formula), behind an (i) glyph beside its header. */
	info?: string;
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
		<Card className="overflow-x-auto" padding="none">
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
								{column.info ? (
									<span className="inline-flex items-center gap-1">
										{column.label}
										<SettingInfo text={column.info} />
									</span>
								) : (
									column.label
								)}
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
										"px-3 py-2 align-top [html[data-input=touch]_&]:py-3",
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
		</Card>
	);
}

/** Bordered chart container; `height` is the canvas height in px (charts need a fixed box). */
export function ChartBox({ height = 260, children }: { height?: number; children: ReactNode }) {
	return (
		<Card padding="lg">
			<div className="relative w-full" style={{ height }}>
				{children}
			</div>
		</Card>
	);
}
