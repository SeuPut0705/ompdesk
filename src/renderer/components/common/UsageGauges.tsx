/**
 * One subscription account's usage as inline gauges: a bar per window (the two tightest, shortest first) with the
 * window's short name and the share used inside it ("5H 62%", "7D 41%"). The fill is the share used, as in
 * Settings; from 80 % the fill turns warning, at 100 % danger. `resets` adds each window's time to reset beneath
 * its bar. Shared by the work board's account row and the sidebar's usage lines.
 */
import type { UsageLimit, UsageReport } from "../../../shared/rpc-types";
import { formatSpan, formatSpanCompact } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { usageLimitLabel } from "../../lib/usage-labels";
import { accountWindows, shortWindowLabel } from "../../lib/usage-windows";

/** From here the window is near its limit (warning); at 100 % it is the limit (danger). */
export const NEAR_FRACTION = 0.8;

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function resetText(resetsAt: number | undefined, t: Translate, now = Date.now()): string | null {
	if (resetsAt === undefined) return null;
	return resetsAt > now ? t("usage.resetsIn", { time: formatSpan(resetsAt - now) }) : t("usage.resetting");
}

/** The account's label, then every window with its share used and its reset: the full names the gauges shorten. */
export function usageTooltip(report: UsageReport, label: string, t: Translate): string {
	return [
		label,
		...report.limits.map((limit: UsageLimit) => {
			const fraction =
				limit.usedFraction ?? (limit.used !== undefined && limit.limit ? limit.used / limit.limit : null);
			return [
				usageLimitLabel(limit, t),
				fraction === null ? null : `${Math.round(fraction * 100)}%`,
				resetText(limit.resetsAt, t),
			]
				.filter(Boolean)
				.join(" · ");
		}),
	].join("\n");
}

export function UsageGauges({
	limits,
	resets = false,
	compact = false,
}: {
	limits: readonly UsageLimit[];
	resets?: boolean;
	compact?: boolean;
}) {
	const t = useT();
	const windows = accountWindows(limits);
	if (windows.length === 0) return null;
	const now = Date.now();
	return (
		<span className="omp-usage-gauges" data-compact={compact || undefined} data-count={windows.length}>
			{windows.map(({ limit, fraction }) => {
				const percent = Math.round(Math.min(1, fraction) * 100);
				return (
					<span
						className="omp-usage-gauge"
						data-state={fraction >= 1 ? "limit" : fraction >= NEAR_FRACTION ? "near" : "ok"}
						data-window={limit.windowId ?? limit.id}
						key={limit.id}
					>
						<span
							aria-label={usageLimitLabel(limit, t)}
							aria-valuemax={100}
							aria-valuemin={0}
							aria-valuenow={percent}
							aria-valuetext={`${percent}%`}
							className="omp-usage-gauge-bar"
							role="progressbar"
						>
							<span className="omp-usage-gauge-fill" style={{ width: `${percent}%` }} />
							<span className="omp-usage-gauge-text">
								<span>{shortWindowLabel(limit)}</span>
								<span>{percent}%</span>
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
