/**
 * Insights › This session › Advisor: what the second model reviewing the turns cost, how many model calls it made
 * and how many advisories it delivered, with its share of the session's spend. Left out while the advisor cannot be
 * read or never ran. Re-reads on the same trigger as the session figures (`refreshKey`).
 */

import { formatPercent, formatUsd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { advisorSeverityBreakdown, hasAdvisorActivity, useAdvisorUsage } from "../layout/composer/AdvisorUsageRow";
import { MetricCard, MetricGrid, SectionTitle } from "../stats/shared";

export function AdvisorInsights({ sessionCost, refreshKey }: { sessionCost: number; refreshKey: string | number }) {
	const t = useT();
	const usage = useAdvisorUsage(false, refreshKey);
	if (usage === null || !hasAdvisorActivity(usage)) return null;

	const spend = sessionCost + usage.cost;
	const costSub = [
		spend > 0 ? t("insights.advisor.share", { percent: formatPercent((usage.cost / spend) * 100) }) : null,
		usage.subscription ? t("insights.advisor.listPrice") : null,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		// SectionTitle drops its top margin as a first child, so the section carries it.
		<section aria-labelledby="insights-advisor" className="mt-8" data-advisor-insights>
			<SectionTitle>
				<span id="insights-advisor">{t("insights.advisor.title")}</span>
			</SectionTitle>
			<MetricGrid>
				<MetricCard label={t("usage.cost")} sub={costSub} value={formatUsd(usage.cost)} />
				<MetricCard
					label={t("insights.advisor.calls")}
					sub={t("insights.advisor.callsSub")}
					value={String(usage.calls)}
				/>
				<MetricCard
					label={t("insights.advisor.advisories")}
					sub={advisorSeverityBreakdown(usage.advisories, t)}
					value={String(usage.advisories.total)}
				/>
			</MetricGrid>
		</section>
	);
}
