/**
 * A cost shown as its kinds, each its own figure and never added together: a metered provider's charge ("$0.09"), a
 * subscription's estimate at API prices ("≈ $0.18") and, while no billing class has been read, the bare figure. The
 * words ("Charged $0.09 · Estimate at API prices $0.18 (subscription, not charged)") are its tooltip and accessible
 * name. Used by the work board and the Work tree, never the sidebar.
 */
import { formatCost } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { COST_KINDS, type CostKinds, costWords } from "../../lib/spend";

/** Whether there is any cost to show. */
export function hasCost(kinds: CostKinds): boolean {
	return kinds.charged > 0 || kinds.estimate > 0 || kinds.unknown > 0;
}

export function CostAmount({
	kinds,
	className,
	data,
}: {
	kinds: CostKinds;
	className?: string;
	data?: Record<`data-${string}`, string | boolean | undefined>;
}) {
	const t = useT();
	const words = costWords(t, kinds);
	return (
		<span aria-label={words} className={className} title={words} {...data}>
			{COST_KINDS.filter(kind => kinds[kind] > 0).map((kind, index) => (
				<span data-cost-kind={kind} key={kind}>
					{index > 0 ? " · " : ""}
					{kind === "estimate" ? "≈ " : ""}
					{formatCost(kinds[kind], 2)}
				</span>
			))}
		</span>
	);
}
