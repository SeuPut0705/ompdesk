/**
 * The work board's account row: the subscription account this session uses now (the provider of the current
 * model; the report stock marks `active`, else the first with limits), then a gauge per usage window with its
 * reset beneath (`UsageGauges`, shared with the sidebar's usage lines). The full window names sit in the tooltip;
 * a click opens Settings › Models & accounts. A provider with no usage windows (an API key) shows nothing.
 */
import { useUsageReports } from "../../hooks/use-usage-reports";
import { useT } from "../../lib/i18n";
import { inUseReport } from "../../lib/usage-reports";
import { accountWindows } from "../../lib/usage-windows";
import { useModelStore } from "../../stores/model";
import { useUiStore } from "../../stores/ui";
import { UsageGauges, usageTooltip } from "../common/UsageGauges";
import { ProviderMark } from "../settings/providers/ProviderMark";

/**
 * "me@example.com (me…)" shows as "me@example.com": a parenthesized name that only repeats the start of the
 * address's local part adds nothing. Any other suffix stays.
 */
export function shortAccountLabel(label: string): string {
	const match = /^(\S+@\S+)\s*\((.*)\)?$/.exec(label);
	if (!match) return label;
	const local = (match[1]?.split("@")[0] ?? "").toLowerCase();
	const inner = (match[2] ?? "")
		.replace(/[….)]+$/, "")
		.trim()
		.toLowerCase();
	return inner === "" || local.startsWith(inner) ? (match[1] ?? label) : label;
}

export function AccountLimit() {
	const t = useT();
	const provider = useModelStore(s => s.model?.provider ?? null);
	const reports = useUsageReports();
	const report = reports ? inUseReport(reports, provider) : undefined;
	if (!report || accountWindows(report.limits).length === 0) return null;

	const fullLabel = report.account?.trim() || report.provider;
	return (
		<button
			className="omp-work-board-account"
			data-board-account={report.provider}
			onClick={() => useUiStore.getState().openProviders()}
			title={usageTooltip(report, fullLabel, t)}
			type="button"
		>
			<span className="omp-work-board-account-name">
				<ProviderMark
					className="omp-work-board-provider"
					provider={{ id: report.provider, name: report.provider }}
				/>
				<span className="min-w-0 flex-1 truncate">{shortAccountLabel(fullLabel)}</span>
			</span>
			<UsageGauges limits={report.limits} resets />
		</button>
	);
}
