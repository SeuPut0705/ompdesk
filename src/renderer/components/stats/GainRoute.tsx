/**
 * Gain: token savings from compaction — totals, per-source breakdown,
 * daily savings chart, and project filter.
 */

import { useMemo, useState } from "react";
import { Bar } from "react-chartjs-2";
import { baseChartOptions, chartTheme, compact, useChartThemeKey, withAlpha } from "../../lib/chart";
import "../../lib/chart";
import type { GainData } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { formatPercent } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Select } from "../common";
import { ChartBox, MetricCard, MetricGrid, RouteFrame, SectionTitle, type StatsRange } from "./shared";

export function GainRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const themeKey = useChartThemeKey();
	const [project, setProject] = useState<string>("");
	const params = useMemo<Record<string, string>>(() => {
		const next: Record<string, string> = { range };
		if (project) next.project = project;
		return next;
	}, [range, project]);
	const { data, isLoading, error, serverDown, refetch } = useStats<GainData>("/api/stats/gain", params);

	const stats = data;
	const overall = stats?.overall;
	const sourceEntries = Object.entries(stats?.bySource ?? {}).filter(([, totals]) => totals.hits > 0);
	const projectOptions = useMemo(
		() => [
			{ value: "", label: t("stats.gain.allProjects") },
			...(stats?.projects ?? []).map(name => ({ value: name, label: name })),
		],
		[stats, t],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey repaints the series colors on a theme switch.
	const chart = useMemo(() => {
		const theme = chartTheme();
		const series = stats?.timeSeries ?? [];
		return {
			labels: series.map(point => point.date),
			datasets: [
				{
					label: t("stats.gain.tokensSaved"),
					data: series.map(point => point.total),
					backgroundColor: withAlpha(theme.accent, 0.53),
					borderColor: theme.accent,
					borderWidth: 1,
				},
			],
		};
	}, [stats, t, themeKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey re-reads the axis tokens on a theme switch.
	const barOptions = useMemo(() => {
		const base = baseChartOptions();
		return {
			...base,
			plugins: { ...base.plugins, legend: { display: false } },
			scales: {
				...base.scales,
				y: {
					...base.scales.y,
					ticks: { ...base.scales.y.ticks, callback: (value: number | string) => compact(Number(value)) },
				},
			},
		};
	}, [themeKey]);

	return (
		<RouteFrame
			hasData={data !== null}
			empty={!overall || overall.savedTokens === 0}
			error={error}
			serverDown={serverDown}
			loading={isLoading}
			onRetry={refetch}
		>
			{overall && (
				<>
					<div className="mb-4 max-w-xs">
						<Select
							controlSize="sm"
							label={t("stats.col.project")}
							onChange={event => setProject(event.target.value)}
							options={projectOptions}
							value={project}
						/>
					</div>
					<MetricGrid>
						<MetricCard label={t("stats.gain.tokensSaved")} tone="success" value={compact(overall.savedTokens)} />
						<MetricCard label={t("stats.gain.compactions")} value={compact(overall.hits)} />
						<MetricCard label={t("stats.gain.reduction")} value={formatPercent(overall.reductionPercent, 0)} />
						<MetricCard label={t("stats.gain.bytesSaved")} value={compact(overall.savedBytes)} />
					</MetricGrid>
					<SectionTitle>{t("stats.gain.daily")}</SectionTitle>
					<ChartBox height={260}>
						<Bar data={chart} options={barOptions} />
					</ChartBox>
					{sourceEntries.length > 0 && <SectionTitle>{t("stats.gain.bySource")}</SectionTitle>}
					{sourceEntries.map(([source, totals]) => (
						<div
							className="mb-1.5 flex items-center gap-3 rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2 text-sc-xs"
							key={source}
						>
							<span className="font-mono font-medium text-(--sc-text)">{source}</span>
							<span className="text-(--sc-text-muted)">
								{t("stats.gain.tokens", { count: compact(totals.savedTokens) })}
							</span>
							<span className="text-(--sc-text-subtle)">{t("stats.gain.hits", { count: totals.hits })}</span>
							{totals.reductionPercent != null && Number.isFinite(totals.reductionPercent) && (
								<span className="ml-auto text-(--sc-success)">
									−{formatPercent(totals.reductionPercent, 0)}
								</span>
							)}
						</div>
					))}
				</>
			)}
		</RouteFrame>
	);
}
