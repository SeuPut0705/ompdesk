/**
 * Insights destination (design-spec §2.2): a full page in the main area.
 * - Stats, with an explicit scope switch: This session (session info +
 *   context window) · All sessions (the global omp stats across projects).
 * - Usage: provider quotas.
 * Tab and scope live in the ui store (`insightsTab`, `insightsStatsScope`,
 * `openInsights(tab, scope)`) so the title-bar status popover, palette,
 * menus and tray land on the right view.
 */

import { useT } from "../../lib/i18n";
import { type InsightsStatsScope, type InsightsTab, useUiStore } from "../../stores/ui";
import { PageLayout, Tabs } from "../common";
import { AllSessionsStats } from "../stats/AllSessionsStats";
import { SessionInsights } from "./SessionInsights";
import { UsageQuotas } from "./UsageQuotas";

const TAB_LABEL_KEY: Record<InsightsTab, string> = {
	stats: "insights.tabs.stats",
	usage: "insights.tabs.usage",
};

const SCOPE_LABEL_KEY: Record<InsightsStatsScope, string> = {
	session: "insights.scope.session",
	all: "insights.scope.all",
};

export function InsightsPage() {
	const t = useT();
	const tab = useUiStore(s => s.insightsTab);
	const scope = useUiStore(s => s.insightsStatsScope);
	const openInsights = useUiStore(s => s.openInsights);

	return (
		<PageLayout
			description={t("insights.description")}
			panelLabel={t(TAB_LABEL_KEY[tab])}
			tabs={
				<Tabs
					activeId={tab}
					ariaLabel={t("insights.title")}
					onChange={id => openInsights(id as InsightsTab)}
					tabs={(Object.keys(TAB_LABEL_KEY) as InsightsTab[]).map(id => ({ id, label: t(TAB_LABEL_KEY[id]) }))}
				/>
			}
			title={t("insights.title")}
		>
			{tab === "stats" ? (
				<div className="flex flex-col gap-6">
					<div className="flex flex-wrap items-center gap-3">
						<Tabs
							activeId={scope}
							ariaLabel={t("insights.scope.label")}
							onChange={id => openInsights("stats", id as InsightsStatsScope)}
							tabs={(Object.keys(SCOPE_LABEL_KEY) as InsightsStatsScope[]).map(id => ({
								id,
								label: t(SCOPE_LABEL_KEY[id]),
							}))}
							variant="segmented"
						/>
						<p className="text-sc-sm text-(--sc-text-muted)">
							{scope === "session" ? t("insights.scope.sessionHint") : t("insights.scope.allHint")}
						</p>
					</div>
					{scope === "session" ? <SessionInsights /> : <AllSessionsStats />}
				</div>
			) : (
				<UsageQuotas />
			)}
		</PageLayout>
	);
}
