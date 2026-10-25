/**
 * Sidebar footer usage block (mixdog's "Rail bars", pin `usage`, on by default): one entry per AI provider company
 * that reports usage windows, showing the account that company's sessions used last (`lastUsedAccounts`, shared with
 * the work board). The first row is the provider mark and two inline gauges ("5H 15%", "7D 39%", the shared
 * `UsageGauges`); a slim second row under it carries that account's email, muted and truncated. The provider this
 * tab uses comes first and is marked with a quiet edge. Reset times, the full window names and the full account
 * label are in each entry's tooltip; a click opens Settings › Models & accounts. API-key providers have no windows
 * and are not listed; with no entry at all the block renders nothing. Reads go through `useUsageReports` (live
 * quotas, no polling of its own).
 */

import { ChevronDown, ChevronRight } from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useUsageReports } from "../../../hooks/use-usage-reports";
import { useT } from "../../../lib/i18n";
import { lastUsedAccounts } from "../../../lib/usage-reports";
import { useModelStore } from "../../../stores/model";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useUiStore } from "../../../stores/ui";
import { UsageGauges, usageDescription, usageTooltip } from "../../common/UsageGauges";
import { ProviderMark } from "../../settings/providers/ProviderMark";
import { bareEmail, shortAccountLabel } from "../AccountLimit";

/** Providers the block stacks before "+N" takes the rest to Settings. */
export const USAGE_LINE_CAP = 4;

export function SidebarUsage({
	onContextMenu,
	onKeyDown,
}: {
	onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}) {
	const t = useT();
	const provider = useModelStore(s => s.model?.provider ?? null);
	const reports = useUsageReports();
	const lines = reports ? lastUsedAccounts(reports, provider) : [];
	// The block folds to its header; the fold is remembered (`stores/sidebar-folds.ts`).
	const collapsed = useSidebarFolds(s => s.usageCollapsed);
	if (lines.length === 0) return null;
	const shown = collapsed ? [] : lines.slice(0, USAGE_LINE_CAP);
	const more = collapsed ? 0 : lines.length - USAGE_LINE_CAP;
	const Chevron = collapsed ? ChevronRight : ChevronDown;
	return (
		<div
			className="omp-sidebar-usage"
			// The block stacks `USAGE_LINE_CAP` providers: past it, the work board's gauges are the only place the rest show.
			data-capped={lines.length > USAGE_LINE_CAP || undefined}
			data-collapsed={collapsed || undefined}
			data-rail-pin="usage"
			onContextMenu={onContextMenu}
			onKeyDown={onKeyDown}
		>
			<button
				aria-expanded={!collapsed}
				className="flex h-6 w-full min-w-0 items-center gap-1 rounded-(--sc-radius-md) px-2 text-sc-xs font-medium text-(--sc-text-muted) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)"
				data-sidebar-usage-toggle
				onClick={() => useSidebarFolds.getState().setUsageCollapsed(!collapsed)}
				type="button"
			>
				<span className="min-w-0 flex-1 truncate text-left">{t("sidebar.pin.usage")}</span>
				<Chevron aria-hidden className="size-(--sc-icon-sm) shrink-0" />
			</button>
			{shown.map(({ report, inUse }) => {
				const label = report.account?.trim() || report.provider;
				const email = shortAccountLabel(label);
				return (
					// controls-ok: the omp-sidebar-usage-line class draws the whole row
					<button
						className="omp-sidebar-usage-line"
						data-in-use={inUse || undefined}
						data-rail-account={`${report.provider}:${report.account ?? ""}`}
						key={report.provider}
						aria-label={usageDescription(report, label, t)}
						onClick={() => useUiStore.getState().openProviders()}
						title={`${usageTooltip(report, bareEmail(label), t)}${inUse ? `\n${t("usage.inUse")}` : ""}`}
						type="button"
					>
						<ProviderMark provider={{ id: report.provider, name: report.provider }} />
						<UsageGauges compact limits={report.limits} />
						<span className="omp-sidebar-usage-account">{email}</span>
					</button>
				);
			})}
			{more > 0 ? (
				// controls-ok: the omp-sidebar-usage-more class draws the whole row
				<button
					className="omp-sidebar-usage-more"
					onClick={() => useUiStore.getState().openProviders()}
					type="button"
				>
					{t("sidebar.pin.usageMore", { count: more })}
				</button>
			) : null}
		</div>
	);
}
