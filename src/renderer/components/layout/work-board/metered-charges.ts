/**
 * What each metered provider charged a session, read from the bridge's `session_spend`: the rows of the work board's
 * money items (SessionSpendLine.tsx) and of the Autopilot head's tooltip (AutopilotBoard.tsx). Apart from
 * `lib/spend.ts` because both users load after the first screen.
 */
import type { SessionSpend } from "../../../../../resources/gui-bridge/model-setup-contracts";
import { formatCost } from "../../../lib/format";

export interface ProviderCharge {
	provider: string;
	/** Stock's display name ("OpenRouter"); an older host sent none, so the id stands in. */
	name: string;
	cost: number;
	today: number;
}

/** The metered providers' charges, the largest first, and the subscriptions' estimate summed apart: never one sum. */
export function splitSpend(spend: SessionSpend | null): { charged: ProviderCharge[]; estimated: number } {
	const charged: ProviderCharge[] = [];
	let estimated = 0;
	for (const [provider, row] of Object.entries(spend?.providers ?? {})) {
		if (row.billing === "metered" && row.cost > 0)
			charged.push({ provider, name: row.name || provider, cost: row.cost, today: row.today });
		else if (row.billing === "subscription" && row.cost > 0) estimated += row.cost;
	}
	charged.sort((a, b) => b.cost - a.cost);
	return { charged, estimated };
}

/** Small charges are fractions of a cent (a judge call is about $0.00002): four decimals below a dollar. */
export const chargeText = (usd: number) => formatCost(usd, usd < 1 ? 4 : 2);
