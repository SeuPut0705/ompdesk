/**
 * The work board's account items: one per provider company that reports usage windows (API-key providers show
 * nothing), each the account that company's sessions used last (`lastUsedAccounts`, shared with the sidebar's
 * usage block), on one line: the provider's mark and its windows' inline gauges ("5H 82%", `UsageGauges compact`).
 * The account's address, every window and its reset are the item's tooltip and accessible name. The provider this
 * tab uses comes first, with a quiet in-use edge; a click opens Settings › Models & accounts.
 */
import { useUsageReports } from "../../hooks/use-usage-reports";
import { useT } from "../../lib/i18n";
import { lastUsedAccounts } from "../../lib/usage-reports";
import { useModelStore } from "../../stores/model";
import { useUiStore } from "../../stores/ui";
import { UsageGauges, usageDescription, usageTooltip } from "../common/UsageGauges";
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

/** The address alone: "me@example.com (Work account)" shows as "me@example.com", the suffix left to the tooltip. */
export function bareEmail(label: string): string {
	return /^(\S+@[^\s(]+)\s*\(/.exec(label.trim())?.[1] ?? label;
}

/**
 * An account label that gives way in the middle of an address: a narrow row shortens the name before the "@" and keeps
 * the domain, which says which account it is ("someone.with.a…@example.com"). Any other label ends in an ellipsis.
 * Renders spans for a flex row (`flex` on the parent, which clips).
 */
export function AccountAddress({ label }: { label: string }) {
	const match = /^([^\s@]+)(@\S+)$/.exec(label.trim());
	if (!match) return <span className="min-w-0 truncate">{label}</span>;
	return (
		<>
			<span className="min-w-0 truncate">{match[1]}</span>
			<span className="shrink-0">{match[2]}</span>
		</>
	);
}

export function AccountLimit() {
	const t = useT();
	const provider = useModelStore(s => s.model?.provider ?? null);
	const reports = useUsageReports();
	const accounts = reports ? lastUsedAccounts(reports, provider) : [];
	if (accounts.length === 0) return null;

	return (
		<>
			{accounts.map(({ report, inUse }) => {
				const fullLabel = report.account?.trim() || report.provider;
				return (
					// controls-ok: the omp-work-board-account class draws the whole control
					<button
						className="omp-work-board-account"
						data-board-account={report.provider}
						data-in-use={inUse || undefined}
						key={report.provider}
						aria-label={usageDescription(report, fullLabel, t)}
						onClick={() => useUiStore.getState().openProviders()}
						title={`${usageTooltip(report, bareEmail(fullLabel), t)}${inUse ? `\n${t("usage.inUse")}` : ""}`}
						type="button"
					>
						<ProviderMark
							className="omp-work-board-provider"
							provider={{ id: report.provider, name: report.provider }}
						/>
						<UsageGauges compact limits={report.limits} />
					</button>
				);
			})}
		</>
	);
}
