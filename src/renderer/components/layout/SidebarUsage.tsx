/**
 * Sidebar footer usage pin (mixdog's "Rail bars"): the tab's provider quota as
 * two thin bars, the short window (5 h) and the weekly one, from stock's usage
 * reports (`get_usage`). Each read is a live call to the provider, so it runs
 * when the pin mounts, when the tab's provider changes, and every five
 * minutes; Insights › Usage has the full cards. Clicking opens that page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageLimit, UsageReport } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { usageLimitLabel } from "../../lib/usage-labels";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { ProgressBar } from "../common";

const REFRESH_MS = 5 * 60_000;
const SHORT_WINDOWS = ["5h"];
const WEEK_WINDOWS = ["7d", "1w", "weekly"];

function usedFraction(limit: UsageLimit): number | null {
	if (limit.usedFraction !== undefined) return limit.usedFraction;
	if (limit.used !== undefined && limit.limit) return limit.used / limit.limit;
	return null;
}

/**
 * The report for `provider` (the signed-in account in use first) and its
 * short and weekly limits; a provider without those windows shows its two
 * fullest limits instead.
 */
export function railLimits(reports: readonly UsageReport[], provider: string | null): UsageLimit[] {
	const own = reports.filter(report => report.provider === provider && report.limits.length > 0);
	const report = own.find(entry => entry.active) ?? own[0];
	if (!report) return [];
	const measured = report.limits.filter(limit => usedFraction(limit) !== null);
	// Whole-account windows only: `anthropic:7d:opus` is a per-model tier of the week.
	const plain = measured.filter(limit => limit.id.split(":").length <= 2);
	const inWindow = (windows: string[]) =>
		plain.find(limit => windows.includes(limit.windowId ?? limit.id.split(":")[1] ?? ""));
	const named = [inWindow(SHORT_WINDOWS), inWindow(WEEK_WINDOWS)].filter(
		(limit): limit is UsageLimit => limit !== undefined,
	);
	if (named.length > 0) return named;
	return [...measured].sort((a, b) => (usedFraction(b) ?? 0) - (usedFraction(a) ?? 0)).slice(0, 2);
}

export function SidebarUsage() {
	const t = useT();
	const tabRpc = useTabRpc();
	const ready = useSessionStore(s => s.status) === "ready";
	const provider = useModelStore(s => s.model?.provider ?? null);
	const [limits, setLimits] = useState<UsageLimit[] | null>(null);
	const latest = useRef(0);

	const load = useCallback(async () => {
		if (!ready) return;
		const call = ++latest.current;
		try {
			const response = await tabRpc.getUsage();
			if (call !== latest.current) return;
			const data: unknown = response.success ? response.data : null;
			const reports: UsageReport[] =
				typeof data === "object" && data !== null && "reports" in data && Array.isArray(data.reports)
					? data.reports
					: [];
			setLimits(railLimits(reports, provider));
		} catch {
			if (call === latest.current) setLimits([]);
		}
	}, [ready, provider, tabRpc.getUsage]);

	useEffect(() => {
		void load();
		const timer = setInterval(() => void load(), REFRESH_MS);
		return () => clearInterval(timer);
	}, [load]);

	const label = t("sidebar.pin.usage");
	return (
		<button
			aria-label={label}
			className="omp-sidebar-destination flex w-full min-w-0 flex-col gap-1.5 rounded-(--sc-radius-md) px-2.5 py-2 text-left text-(--sc-text-secondary) hover:bg-(--sc-hover) focus-visible:outline-none"
			data-rail-pin="usage"
			onClick={() => useUiStore.getState().openInsights("usage")}
			type="button"
		>
			{limits === null ? (
				<span className="text-sc-xs text-(--sc-text-muted)">{label}</span>
			) : limits.length === 0 ? (
				<span className="text-sc-xs text-(--sc-text-muted)">{t("sidebar.pin.usageNone")}</span>
			) : (
				limits.map(limit => {
					const fraction = usedFraction(limit) ?? 0;
					const name = usageLimitLabel(limit, t);
					return (
						<span className="flex min-w-0 flex-col gap-1" data-rail-limit={limit.id} key={limit.id}>
							<span className="flex min-w-0 items-center justify-between gap-2 text-sc-xs">
								<span className="min-w-0 truncate">{name}</span>
								<span className="shrink-0 tabular-nums text-(--sc-text-muted)">
									{Math.round(fraction * 100)}%
								</span>
							</span>
							<ProgressBar ariaLabel={name} height={3} value={fraction} valueText="" />
						</span>
					);
				})
			)}
		</button>
	);
}
