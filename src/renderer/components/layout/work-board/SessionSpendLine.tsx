/**
 * The work board's money items, beside the account gauges on the head's meters line: one per metered provider this
 * session spent on (an API key, OpenRouter: the judge's calls land here through stock's journal), its mark, name and
 * the session's real charge; today's charge is the tooltip with the words. Subscriptions' spend is never added in:
 * it is an estimate at API prices, named once as such in the tooltip when there is any. Loaded by `WorkBoard.tsx`
 * only once the session spent on a metered provider.
 */
import type { SessionSpend } from "../../../../../resources/gui-bridge/model-setup-contracts";
import { formatCost } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { ProviderMark } from "../../settings/providers/ProviderMark";
import { chargeText as charge, splitSpend } from "./metered-charges";

export function SessionSpendLine({ spend }: { spend: SessionSpend }) {
	const t = useT();
	const { charged, estimated } = splitSpend(spend);
	const estimateNote = estimated > 0 ? t("workBoard.spend.estimate", { cost: formatCost(estimated, 2) }) : "";
	return (
		<>
			{charged.map(row => {
				const words = t("workBoard.spend.charged", {
					provider: row.name,
					cost: charge(row.cost),
					today: charge(row.today),
				});
				return (
					<div
						aria-label={words}
						className="omp-work-board-spend"
						data-board-spend
						data-board-spend-provider={row.provider}
						key={row.provider}
						role="group"
						title={[words, t("workBoard.spend.chargedInfo"), estimateNote].filter(Boolean).join("\n")}
					>
						<ProviderMark className="omp-work-board-provider" provider={{ id: row.provider, name: row.name }} />
						<span className="min-w-0 truncate" data-board-spend-name>
							{row.name}
						</span>
						<span className="shrink-0 tabular-nums" data-board-spend-cost>
							{charge(row.cost)}
						</span>
					</div>
				);
			})}
		</>
	);
}
