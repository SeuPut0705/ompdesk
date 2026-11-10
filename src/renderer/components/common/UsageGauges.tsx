/**
 * One subscription account's usage as inline gauges: a bar per window (the two tightest, shortest first) with the
 * window's short name and the share used inside it ("5H 62%", "7D 41%"). The fill is the share used, as in
 * Settings; from 80 % the fill turns warning, at 100 % danger. `resets` adds each window's time to reset beneath
 * its bar. Shared by the work board's account row and the sidebar's usage lines. With `columns` (the Settings
 * accounts list) it draws every measured window, model-scoped ones included ("Fable 44%"), each in its column of
 * the provider's shared set, and leaves the column of a window the account does not report empty.
 */
import type { CSSProperties } from "react";
import type { UsageLimit, UsageReport } from "../../../shared/rpc-types";
import { formatSpan, formatSpanCompact } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { usageLimitLabel } from "../../lib/usage-labels";
import { accountGauges, accountWindows, gaugeColumn, shortWindowLabel } from "../../lib/usage-windows";

/** Columns drawn on one line; a provider with more wraps the rest under them. */
export const MAX_USAGE_COLUMNS = 4;

/** From here the window is near its limit (warning); at 100 % it is the limit (danger). */
export const NEAR_FRACTION = 0.8;

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function resetText(resetsAt: number | undefined, t: Translate, now = Date.now()): string | null {
	if (resetsAt === undefined) return null;
	return resetsAt > now ? t("usage.resetsIn", { time: formatSpan(resetsAt - now) }) : t("usage.resetting");
}

function limitShare(limit: UsageLimit): string | null {
	const fraction = limit.usedFraction ?? (limit.used !== undefined && limit.limit ? limit.used / limit.limit : null);
	return fraction === null ? null : `${Math.round(fraction * 100)}%`;
}

/**
 * The account's label, then every window as the gauges name it, compact: "5H 23% · ↻ 1h 54m". A limit the gauges
 * do not draw (a per-model tier, a call count) keeps its full name. The long localized sentences are
 * {@link usageDescription}, the screen-reader text.
 */
export function usageTooltip(report: UsageReport, label: string, t: Translate, now = Date.now()): string {
	const drawn = new Set(accountWindows(report.limits).map(({ limit }) => limit));
	return [
		label,
		...report.limits.map((limit: UsageLimit) => {
			const reset =
				limit.resetsAt === undefined
					? null
					: limit.resetsAt > now
						? `↻ ${formatSpanCompact(limit.resetsAt - now)}`
						: "↻";
			const share = limitShare(limit);
			const head = drawn.has(limit)
				? [shortWindowLabel(limit), share].filter(Boolean).join(" ")
				: [usageLimitLabel(limit, t), share].filter(Boolean).join(" · ");
			return [head, reset].filter(Boolean).join(" · ");
		}),
	].join("\n");
}

/** The same lines in full localized sentences ("5 hour · 23% · resets in 1h 54m"): the aria-label of a usage row. */
export function usageDescription(report: UsageReport, label: string, t: Translate): string {
	return [
		label,
		...report.limits.map((limit: UsageLimit) =>
			[usageLimitLabel(limit, t), limitShare(limit), resetText(limit.resetsAt, t)].filter(Boolean).join(" · "),
		),
	].join("\n");
}

export function UsageGauges({
	limits,
	resets = false,
	compact = false,
	columns,
	tracks,
}: {
	limits: readonly UsageLimit[];
	resets?: boolean;
	compact?: boolean;
	/** `gaugeColumns` of the provider's accounts: every window, each in its column. */
	columns?: readonly string[];
	/** With `columns`: the grid's column count, when a list of several providers shares one wider than this one's. */
	tracks?: number;
}) {
	const t = useT();
	const windows = columns ? accountGauges(limits) : accountWindows(limits);
	if (windows.length === 0) return null;
	const now = Date.now();
	const slots = columns
		? columns.map(column => windows.find(entry => gaugeColumn(entry.limit) === column) ?? column)
		: windows;
	return (
		<span
			className="omp-usage-gauges"
			data-columns={columns ? "" : undefined}
			data-compact={compact || undefined}
			data-count={windows.length}
			style={
				columns
					? ({
							"--omp-usage-columns": Math.min(Math.max(columns.length, tracks ?? 0), MAX_USAGE_COLUMNS),
						} as CSSProperties)
					: undefined
			}
		>
			{slots.map(slot => {
				if (typeof slot === "string") {
					return <span aria-hidden className="omp-usage-gauge" data-empty="" data-window={slot} key={slot} />;
				}
				const { limit, fraction } = slot;
				const percent = Math.round(Math.min(1, fraction) * 100);
				return (
					<span
						className="omp-usage-gauge"
						data-state={fraction >= 1 ? "limit" : fraction >= NEAR_FRACTION ? "near" : "ok"}
						data-window={columns ? gaugeColumn(limit) : (limit.windowId ?? limit.id)}
						key={limit.id}
					>
						<span
							// The name read with its value ("5시간 64%"), not the glyphs "5H" and "64%".
							aria-label={`${usageLimitLabel(limit, t)} ${percent}%`}
							aria-valuemax={100}
							aria-valuemin={0}
							aria-valuenow={percent}
							aria-valuetext={`${percent}%`}
							className="omp-usage-gauge-bar"
							role="progressbar"
						>
							<span className="omp-usage-gauge-fill" style={{ transform: `scaleX(${percent / 100})` }} />
							<span aria-hidden className="omp-usage-gauge-text">
								<span data-usage-label>{shortWindowLabel(limit)}</span>
								<span data-usage-percent>{percent}%</span>
							</span>
						</span>
						{resets && limit.resetsAt !== undefined ? (
							<span
								aria-label={resetText(limit.resetsAt, t, now) ?? undefined}
								className="omp-usage-gauge-reset"
								role="img"
								title={resetText(limit.resetsAt, t, now) ?? undefined}
							>
								{limit.resetsAt > now ? `↻ ${formatSpanCompact(limit.resetsAt - now)}` : "↻"}
							</span>
						) : resets ? (
							<span className="omp-usage-gauge-reset" />
						) : null}
					</span>
				);
			})}
		</span>
	);
}
