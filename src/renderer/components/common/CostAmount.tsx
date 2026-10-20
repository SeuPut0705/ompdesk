/**
 * A dollar figure that says what it is: a subscription's estimate at API prices reads "≈ $0.25" with the words in
 * its tooltip and accessible name; a metered provider's charge reads "$0.25" named as charged. With no basis known
 * (billing not read yet) the figure stands alone. Used by the work board and the Work tree, never the sidebar.
 */
import { formatCost } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { CostBasis } from "../../lib/spend";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** A cost in words: "Estimate at API prices $0.25", "Charged $0.25", or the bare figure while the basis is unknown. */
export function costWords(t: Translate, cost: number, basis: CostBasis | undefined): string {
	const amount = formatCost(cost, 2);
	return basis ? t(`cost.${basis}`, { cost: amount }) : amount;
}

/** The figure as shown: an estimate carries "≈". */
export function costFigure(cost: number, basis: CostBasis | undefined): string {
	return `${basis === "estimate" ? "≈ " : ""}${formatCost(cost, 2)}`;
}

export function CostAmount({
	cost,
	basis,
	className,
	data,
}: {
	cost: number;
	basis: CostBasis | undefined;
	className?: string;
	data?: Record<`data-${string}`, string | boolean | undefined>;
}) {
	const t = useT();
	const words = basis ? costWords(t, cost, basis) : undefined;
	return (
		<span aria-label={words} className={className} data-cost-basis={basis} title={words} {...data}>
			{costFigure(cost, basis)}
		</span>
	);
}
