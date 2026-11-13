/**
 * The work board's account items: one per provider company that reports usage windows (API-key providers show
 * nothing), each the account that company's sessions used last (`lastUsedAccounts`), on one line: the provider's
 * mark and its windows' inline gauges ("5H 82%", `UsageGauges compact`),
 * then the account's model-scoped window ("Fable 44%"): the one of the model this tab runs on, which decides whether
 * its next turn runs, else the tightest (`accountWindows` with `session`).
 * The account's address, every window and its reset are the item's tooltip and accessible name. The provider this
 * tab uses comes first, with a quiet in-use edge; a click opens Settings › Models & accounts.
 */
import { useUsageReports } from "../../hooks/use-usage-reports";
import { useT } from "../../lib/i18n";
import { lastUsedAccounts } from "../../lib/usage-reports";
import { useModelStore } from "../../stores/model";
import { useUiStore } from "../../stores/ui";
import { UsageGauges, usageDescription, usageTooltip } from "../common";
import { ProviderMark } from "../settings/providers/ProviderMark";

/** The address alone: "me@example.com (Work account)" shows as "me@example.com", the suffix left to the tooltip. */
export function bareEmail(label: string): string {
	return /^(\S+@[^\s(]+)\s*\(/.exec(label.trim())?.[1] ?? label;
}

export function AccountLimit() {
	const t = useT();
	const model = useModelStore(s => s.model);
	const reports = useUsageReports();
	const accounts = reports ? lastUsedAccounts(reports, model?.provider ?? null) : [];
	if (accounts.length === 0) return null;

	return (
		<>
			{accounts.map(({ report, inUse }) => {
				const fullLabel = report.account?.trim() || report.provider;
				const session = { model: inUse ? (model?.id ?? null) : null };
				return (
					// controls-ok: the omp-work-board-account class draws the whole control
					<button
						className="omp-work-board-account"
						data-board-account={report.provider}
						data-in-use={inUse || undefined}
						key={report.provider}
						aria-label={usageDescription(report, fullLabel, t)}
						onClick={() => useUiStore.getState().openProviders()}
						title={`${usageTooltip(report, bareEmail(fullLabel), t, session)}${inUse ? `\n${t("usage.inUse")}` : ""}`}
						type="button"
					>
						<ProviderMark
							className="omp-work-board-provider"
							provider={{ id: report.provider, name: report.provider }}
						/>
						<UsageGauges compact limits={report.limits} session={session} />
					</button>
				);
			})}
		</>
	);
}
