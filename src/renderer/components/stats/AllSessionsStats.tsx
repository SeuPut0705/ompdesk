/**
 * Insights › Stats › All sessions: the global omp stats across every project
 * and session on the focused tab's machine — this one, or the paired host the
 * tab runs on (the stats HTTP API through the stats:fetch IPC bridge). Left
 * sub-nav for the ten sections, a range switch and a sync action above the
 * active section. A quiet sync runs on mount; when the stats server is down
 * for good the page shows one calm state with a retry instead of ten failing
 * sections.
 */

import { BarChart3, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { runStatsSync } from "../../lib/stats-sync";
import { useFocusedTabDevice } from "../../stores/remote";
import { toast, toastError } from "../../stores/toast";
import { Button, EmptyState, SettingInfo, Tabs } from "../common";
import { CostsRoute } from "./CostsRoute";
import { ErrorsRoute } from "./ErrorsRoute";
import { FrustrationRoute } from "./FrustrationRoute";
import { GainRoute } from "./GainRoute";
import { ModelsRoute } from "./ModelsRoute";
import { OverviewRoute } from "./OverviewRoute";
import { ProjectsRoute } from "./ProjectsRoute";
import { ProvidersRoute } from "./ProvidersRoute";
import { RequestsRoute } from "./RequestsRoute";
import { STATS_RANGES, type StatsRange } from "./shared";
import { ToolsRoute } from "./ToolsRoute";

const ROUTES = [
	{ id: "overview", labelKey: "stats.overview", View: OverviewRoute },
	{ id: "models", labelKey: "stats.models", View: ModelsRoute },
	{ id: "providers", labelKey: "stats.providers", View: ProvidersRoute },
	{ id: "tools", labelKey: "stats.tools", View: ToolsRoute },
	{ id: "costs", labelKey: "stats.costs", View: CostsRoute },
	{ id: "errors", labelKey: "stats.errors", View: ErrorsRoute },
	{ id: "frustration", labelKey: "stats.frustration", View: FrustrationRoute },
	{ id: "gain", labelKey: "stats.gain", View: GainRoute },
	{ id: "projects", labelKey: "stats.projects", View: ProjectsRoute },
	{ id: "requests", labelKey: "stats.requests", View: RequestsRoute },
] as const;

type RouteId = (typeof ROUTES)[number]["id"];

export function AllSessionsStats() {
	const t = useT();
	const device = useFocusedTabDevice();
	const [route, setRoute] = useState<RouteId>("overview");
	const [range, setRange] = useState<StatsRange>("24h");
	const [refreshKey, setRefreshKey] = useState(0);
	const [syncing, setSyncing] = useState(false);
	const [stopped, setStopped] = useState(false);

	const sync = useCallback(
		async (opts?: { quiet?: boolean }) => {
			setSyncing(true);
			try {
				const outcome = await runStatsSync(path => window.omp.stats.fetch(path, undefined, device));
				if (outcome.kind === "stopped") {
					// The page itself says so; a toast would repeat it in raw form.
					setStopped(true);
					return;
				}
				setStopped(false);
				if (outcome.kind === "unavailable") {
					// Server still booting: the sections show a loading state and recover on
					// their own, so the quiet auto-sync must not alarm the user.
					if (!opts?.quiet) {
						toast({ variant: "warning", title: t("stats.syncFailed"), message: t("stats.starting") });
					}
					return;
				}
				if (outcome.kind === "error") {
					// The quiet mount sync stays silent: the section below shows its own error state.
					if (!opts?.quiet) {
						toastError({ title: t("stats.syncFailed"), error: outcome.message });
					}
					return;
				}
				if (!opts?.quiet) {
					toast(
						outcome.kind === "done"
							? {
									variant: "success",
									title: t("stats.syncDone"),
									message: t("stats.syncDetail", { messages: outcome.processed, files: outcome.files }),
								}
							: { variant: "info", title: t("stats.sync"), message: t("stats.syncBackground") },
					);
				}
				setRefreshKey(key => key + 1);
			} catch (error) {
				if (!opts?.quiet) {
					toastError({ title: t("stats.syncFailed"), error });
				}
			} finally {
				setSyncing(false);
			}
		},
		[device, t],
	);

	// Quiet auto-sync once per mount (no toast spam).
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire on mount only.
	useEffect(() => {
		void sync({ quiet: true });
	}, []);

	const active = ROUTES.find(item => item.id === route) ?? ROUTES[0];
	const View = active.View;
	if (stopped) {
		return (
			<EmptyState
				actions={
					<Button icon={<RefreshCw />} loading={syncing} onClick={() => void sync()} size="sm" variant="secondary">
						{t("common.retry")}
					</Button>
				}
				description={t("stats.stopped.desc")}
				icon={<BarChart3 />}
				title={t("stats.stopped.title")}
			/>
		);
	}

	return (
		<div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:gap-8">
			<div className="min-w-0 shrink-0 lg:w-40">
				<Tabs
					activeId={route}
					ariaLabel={t("stats.sectionsAria")}
					className="max-lg:flex-row max-lg:items-center max-lg:gap-1 max-lg:overflow-x-auto lg:sticky lg:top-0"
					data-stats-nav
					onChange={id => setRoute(id as RouteId)}
					orientation="vertical"
					tabs={ROUTES.map(item => ({ id: item.id, label: t(item.labelKey), className: "max-lg:w-auto" }))}
					variant="pills"
				/>
			</div>
			<section aria-label={t(active.labelKey)} className="min-w-0 flex-1">
				{/* The selected tab names the section on screen; the heading stays for the outline a screen reader walks. */}
				<h2 className="sr-only">{t(active.labelKey)}</h2>
				<div className="mb-6 flex flex-wrap items-center justify-end gap-2">
					<Tabs
						activeId={range}
						ariaLabel={t("stats.rangeAria")}
						// Six ranges are wider than a phone: they wrap rather than cut "All time" off.
						className="max-w-full flex-wrap"
						onChange={id => setRange(id as StatsRange)}
						tabs={STATS_RANGES.map(value => ({ id: value, label: t(`stats.range.${value}`) }))}
						variant="segmented"
					/>
					{/* Sync and the (i) about what it counts wrap as one, so the glyph never ends up alone on a line. */}
					<div className="flex items-center gap-2" data-stats-sync>
						<Button
							icon={<RefreshCw />}
							onClick={() => void sync()}
							size="sm"
							loading={syncing}
							variant="secondary"
						>
							{t("stats.sync")}
						</Button>
						<SettingInfo text={t("stats.scope")} />
					</div>
				</div>
				<View key={`${route}:${refreshKey}`} range={range} />
			</section>
		</div>
	);
}
