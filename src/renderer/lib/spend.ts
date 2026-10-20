/**
 * Money a session spent, as two kinds that are never one sum: what a metered provider (API key, OpenRouter, any
 * provider stock cannot prove is a subscription) charged, and what a subscription's calls would cost at API prices,
 * an estimate nobody is billed. Billing classes come from the bridge's `session_spend` (stock's auth data, the model
 * setup's rule, `model-setup-billing-core.ts`).
 */
import type { Billing, SessionSpend } from "../../../resources/gui-bridge/model-setup-contracts";

export interface ProviderCharge {
	provider: string;
	cost: number;
	today: number;
}

export interface SplitSpend {
	/** Metered providers, the largest charge first. */
	charged: ProviderCharge[];
	/** Subscriptions' spend at API prices, summed: an estimate, not a charge. */
	estimated: { cost: number; today: number };
}

export function splitSpend(spend: SessionSpend): SplitSpend {
	const charged: ProviderCharge[] = [];
	const estimated = { cost: 0, today: 0 };
	for (const [provider, row] of Object.entries(spend.providers)) {
		if (row.billing === "metered") charged.push({ provider, cost: row.cost, today: row.today });
		else if (row.billing === "subscription") {
			estimated.cost += row.cost;
			estimated.today += row.today;
		}
	}
	charged.sort((a, b) => b.cost - a.cost);
	return { charged, estimated };
}

/** How a cost is worded: what a provider charged, or a subscription's estimate at API prices. */
export type CostBasis = "charged" | "estimate";

/**
 * The basis of a cost spent on `models` (`provider/id`): an estimate when any of them runs on a subscription (part of
 * the sum is then no charge), a charge when every one is metered, undefined while a billing class is unknown.
 */
export function costBasis(
	billing: Readonly<Record<string, Billing>> | undefined,
	models: Iterable<string | undefined>,
): CostBasis | undefined {
	if (!billing) return undefined;
	let known = false;
	for (const model of models) {
		const slash = model?.indexOf("/") ?? -1;
		const kind = model && slash > 0 ? billing[model.slice(0, slash)] : undefined;
		if (kind === "subscription") return "estimate";
		if (kind === "metered") known = true;
	}
	return known ? "charged" : undefined;
}
