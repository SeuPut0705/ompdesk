/**
 * The work board's money line, under the account rows: one row per metered provider this session spent on (an API
 * key, OpenRouter: the judge's calls land here through stock's journal), with the real charge for the session and
 * for today. Subscriptions' spend is never added in: it is an estimate at API prices, named once as such in the
 * row's tooltip when there is any. Loaded by `WorkBoard.tsx` only once the session spent on a metered provider.
 */
import type { SessionSpend } from "../../../../../resources/gui-bridge/model-setup-contracts";
import { formatCost } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { splitSpend } from "../../../lib/spend";
import { ProviderMark } from "../../settings/providers/ProviderMark";

/** Small charges are fractions of a cent (a judge call is about $0.00002): four decimals below a dollar. */
const charge = (usd: number) => formatCost(usd, usd < 1 ? 4 : 2);

export function SessionSpendLine({ spend }: { spend: SessionSpend }) {
	const t = useT();
	const { charged, estimated } = splitSpend(spend);
	const estimateNote =
		estimated.cost > 0 ? t("workBoard.spend.estimate", { cost: formatCost(estimated.cost, 2) }) : "";
	return (
		<div className="omp-work-board-accounts" data-board-spend>
			{charged.map(row => {
				const words = t("workBoard.spend.charged", {
					provider: row.provider,
					cost: charge(row.cost),
					today: charge(row.today),
				});
				return (
					<div
						aria-label={words}
						className="omp-work-board-spend"
						data-board-spend-provider={row.provider}
						key={row.provider}
						role="group"
						title={[words, t("workBoard.spend.chargedInfo"), estimateNote].filter(Boolean).join("\n")}
					>
						<ProviderMark
							className="omp-work-board-provider"
							provider={{ id: row.provider, name: row.provider }}
						/>
						<span className="min-w-0 flex-1 truncate">{row.provider}</span>
						<span className="shrink-0 tabular-nums" data-board-spend-cost>
							{charge(row.cost)}
						</span>
						<span className="shrink-0 text-(--sc-text-subtle) tabular-nums" data-board-spend-today>
							{t("workBoard.spend.today", { cost: charge(row.today) })}
						</span>
					</div>
				);
			})}
		</div>
	);
}
