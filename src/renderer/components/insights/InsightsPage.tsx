/**
 * Insights destination (design-spec §2.2): a full page in the main area.
 * - Stats, with an explicit scope switch: This session (session info +
 *   context window) · All sessions (the global omp stats across projects).
 * - Usage: provider quotas.
 * Tab and scope live in the ui store (`insightsTab`, `insightsStatsScope`,
 * `openInsights(tab, scope)`) so the title-bar status popover, palette,
 * menus and tray land on the right view. A focused tab on a paired host shows
 * that host's stats and quotas (named in a banner), or its offline notice.
 */

import { useT } from "../../lib/i18n";
import { useFocusedHost } from "../../stores/remote";
import { type InsightsStatsScope, type InsightsTab, useUiStore } from "../../stores/ui";
import { Banner, PageLayout, Tabs } from "../common";
import { DeviceChip } from "../remote/DeviceChip";
import { HostScoped } from "../remote/HostScope";
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
	const host = useFocusedHost();

	return (
		<PageLayout
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
			{host && (
				<div data-insights-device-banner={host.deviceId}>
					<Banner actions={<DeviceChip deviceId={host.deviceId} />} className="mb-5">
						{t("insights.device", { name: host.name ?? t("remote.tab.unknownDevice") })}
					</Banner>
				</div>
			)}
			<HostScoped>
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
						</div>
						{/* Another machine is another stats server: start its page over. */}
						{scope === "session" ? <SessionInsights /> : <AllSessionsStats key={host?.deviceId ?? ""} />}
					</div>
				) : (
					<UsageQuotas />
				)}
			</HostScoped>
		</PageLayout>
	);
}
