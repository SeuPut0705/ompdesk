/**
 * The work board's account rows: one per provider company that reports usage windows (API-key providers show
 * nothing), each the account that company's sessions used last (`lastUsedAccounts`, shared with the sidebar's
 * usage block): its email, then a gauge per usage window with its reset beneath (`UsageGauges`). The provider this
 * tab uses comes first, with a quiet in-use edge. The full account label and window names sit in each row's
 * tooltip; a click opens Settings › Models & accounts.
 */
import { useUsageReports } from "../../hooks/use-usage-reports";
import { useT } from "../../lib/i18n";
import { lastUsedAccounts } from "../../lib/usage-reports";
import { useModelStore } from "../../stores/model";
import { useUiStore } from "../../stores/ui";
import { UsageGauges, usageTooltip } from "../common/UsageGauges";
import { ProviderMark } from "../settings/providers/ProviderMark";

/**
 * "me@example.com (me…)" shows as "me@example.com": a parenthesized name that only repeats the start of the
 * address (or its local part) adds nothing, however it is cut ("(me…)", "(me...", "(me)"). Any other suffix stays.
 */
export function shortAccountLabel(label: string): string {
	const match = /^(\S+@[^\s(]+)\s*\((.*)$/.exec(label.trim());
	if (!match) return label;
	const email = (match[1] ?? "").toLowerCase();
	const inner = (match[2] ?? "")
		.replace(/[….)\s]+$/, "")
		.trim()
		.toLowerCase();
	return inner === "" || email.startsWith(inner) ? (match[1] ?? label) : label;
}

export function AccountLimit() {
	const t = useT();
	const provider = useModelStore(s => s.model?.provider ?? null);
	const reports = useUsageReports();
	const accounts = reports ? lastUsedAccounts(reports, provider) : [];
	if (accounts.length === 0) return null;

	return (
		<div className="omp-work-board-accounts">
			{accounts.map(({ report, inUse }) => {
				const fullLabel = report.account?.trim() || report.provider;
				return (
					<button
						className="omp-work-board-account"
						data-board-account={report.provider}
						data-in-use={inUse || undefined}
						key={report.provider}
						onClick={() => useUiStore.getState().openProviders()}
						title={`${usageTooltip(report, fullLabel, t)}${inUse ? `\n${t("usage.inUse")}` : ""}`}
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
			})}
		</div>
	);
}
