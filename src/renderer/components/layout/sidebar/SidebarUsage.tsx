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

import { useUsageReports } from "../../../hooks/use-usage-reports";
import { useT } from "../../../lib/i18n";
import { lastUsedAccounts } from "../../../lib/usage-reports";
import { useModelStore } from "../../../stores/model";
import { useUiStore } from "../../../stores/ui";
import { UsageGauges, usageTooltip } from "../../common/UsageGauges";
import { ProviderMark } from "../../settings/providers/ProviderMark";
import { shortAccountLabel } from "../AccountLimit";

/** Providers the block stacks before "+N" takes the rest to Settings. */
export const USAGE_LINE_CAP = 4;

export function SidebarUsage() {
	const t = useT();
	const provider = useModelStore(s => s.model?.provider ?? null);
	const reports = useUsageReports();
	const lines = reports ? lastUsedAccounts(reports, provider) : [];
	if (lines.length === 0) return null;
	const shown = lines.slice(0, USAGE_LINE_CAP);
	const more = lines.length - shown.length;
	return (
		<div className="omp-sidebar-usage" data-rail-pin="usage">
			{shown.map(({ report, inUse }) => {
				const label = report.account?.trim() || report.provider;
				const email = shortAccountLabel(label);
				return (
					<button
						className="omp-sidebar-usage-line"
						data-in-use={inUse || undefined}
						data-rail-account={`${report.provider}:${report.account ?? ""}`}
						key={report.provider}
						onClick={() => useUiStore.getState().openProviders()}
						title={`${usageTooltip(report, label, t)}${inUse ? `\n${t("usage.inUse")}` : ""}`}
						type="button"
					>
						<ProviderMark provider={{ id: report.provider, name: report.provider }} />
						<UsageGauges compact limits={report.limits} />
						<span className="omp-sidebar-usage-account">{email}</span>
					</button>
				);
			})}
			{more > 0 ? (
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
