/**
 * Sidebar footer usage block (mixdog's "Rail bars", pin `usage`, on by default): one compact line per subscription
 * account that reports usage windows — the provider mark and two inline gauges ("5H 15%", "7D 39%", the shared
 * `UsageGauges`) — stacked in the providers list's order (company, then account), the account this tab uses
 * marked quietly. Reset times and full window names are in each line's tooltip; a click opens Settings › Models &
 * accounts. API-key providers have no windows and are not listed; with no line at all the block renders nothing.
 * Reads go through `useUsageReports` (live quotas, no polling of its own).
 */

import type { UsageReport } from "../../../shared/rpc-types";
import { useUsageReports } from "../../hooks/use-usage-reports";
import { useT } from "../../lib/i18n";
import { inUseReport } from "../../lib/usage-reports";
import { accountWindows } from "../../lib/usage-windows";
import { useModelStore } from "../../stores/model";
import { useUiStore } from "../../stores/ui";
import { UsageGauges, usageTooltip } from "../common/UsageGauges";
import { ProviderMark } from "../settings/providers/ProviderMark";
import { providerBrand } from "../settings/providers/provider-marks";
import { shortAccountLabel } from "./AccountLimit";

/** Lines the block stacks before "+N" takes the rest to Settings. */
export const USAGE_LINE_CAP = 4;

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export interface UsageLine {
	report: UsageReport;
	/** The account this tab's session uses. */
	inUse: boolean;
}

/** Reports with usage windows, ordered like the providers list: by company, then account. */
export function usageLines(reports: readonly UsageReport[], provider: string | null): UsageLine[] {
	const current = inUseReport(reports, provider);
	return reports
		.filter(report => accountWindows(report.limits).length > 0)
		.map(report => ({ report, company: providerBrand({ id: report.provider, name: report.provider }).company }))
		.sort(
			(a, b) =>
				collator.compare(a.company, b.company) ||
				collator.compare(a.report.account ?? "", b.report.account ?? "") ||
				collator.compare(a.report.provider, b.report.provider),
		)
		.map(({ report }) => ({ report, inUse: report === current }));
}

export function SidebarUsage() {
	const t = useT();
	const provider = useModelStore(s => s.model?.provider ?? null);
	const reports = useUsageReports();
	const lines = reports ? usageLines(reports, provider) : [];
	if (lines.length === 0) return null;
	const shown = lines.slice(0, USAGE_LINE_CAP);
	const more = lines.length - shown.length;
	return (
		<div className="omp-sidebar-usage" data-rail-pin="usage">
			{shown.map(({ report, inUse }) => {
				const label = report.account?.trim() || report.provider;
				return (
					<button
						className="omp-sidebar-usage-line"
						data-in-use={inUse || undefined}
						data-rail-account={`${report.provider}:${report.account ?? ""}`}
						key={`${report.provider}:${report.credentialId ?? report.account ?? ""}`}
						onClick={() => useUiStore.getState().openProviders()}
						title={`${usageTooltip(report, shortAccountLabel(label), t)}${inUse ? `\n${t("usage.inUse")}` : ""}`}
						type="button"
					>
						<ProviderMark provider={{ id: report.provider, name: report.provider }} />
						<UsageGauges compact limits={report.limits} />
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
