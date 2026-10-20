/**
 * Money a session spent, as kinds that are never one sum: what a metered provider (API key, OpenRouter, any provider
 * stock cannot prove is a subscription) charged, and what a subscription's calls would cost at API prices, an
 * estimate nobody is billed. Billing classes come from stock's auth data through the bridge's `session_spend` (the
 * model setup's rule, `model-setup-billing-core.ts`); a child's own split is classed on the host that runs it.
 * Only what the work board's first screen needs lives here (the phone's first-screen budget); the rest sits beside
 * its lazy users (`addKinds` in work-tree.ts, `hasCost` in CostAmount.tsx, the spend rows in SessionSpendLine.tsx).
 */
import type { Billing } from "../../../resources/gui-bridge/model-setup-contracts";
import type { CostSplit } from "../../shared/agent-control";
import { formatCost } from "./format";

/**
 * A cost as its kinds: `charged` (metered), `estimate` (a subscription at API prices) and `unknown` (no billing class
 * read yet). Each kind is shown as its own figure; adding two kinds together is the one thing never done.
 */
export interface CostKinds extends CostSplit {
	unknown: number;
}

export const NO_COST: CostKinds = { charged: 0, estimate: 0, unknown: 0 };

/** What a usage cost, by kind: its own host's split when it has one, else its whole cost by its model's billing. */
export function costKinds(
	usage: { model?: string; cost?: number; split?: CostSplit } | undefined,
	billing: Readonly<Record<string, Billing>> | undefined,
): CostKinds {
	if (usage?.split) return { charged: usage.split.charged, estimate: usage.split.estimate, unknown: 0 };
	const cost = usage?.cost;
	if (!cost || !Number.isFinite(cost) || cost <= 0) return NO_COST;
	const slash = usage.model?.indexOf("/") ?? -1;
	const kind = billing && usage.model && slash > 0 ? (billing[usage.model.slice(0, slash)] ?? "metered") : undefined;
	if (kind === "free") return NO_COST;
	if (kind === "subscription") return { ...NO_COST, estimate: cost };
	if (kind === "metered") return { ...NO_COST, charged: cost };
	return { ...NO_COST, unknown: cost };
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

export const COST_KINDS = ["charged", "estimate", "unknown"] as const;

/** The kinds in words, " · " between them; "" for no cost. */
export function costWords(t: Translate, kinds: CostKinds): string {
	return COST_KINDS.filter(kind => kinds[kind] > 0)
		.map(kind => {
			const amount = formatCost(kinds[kind], 2);
			return kind === "unknown" ? amount : t(`cost.${kind}`, { cost: amount });
		})
		.join(" · ");
}
