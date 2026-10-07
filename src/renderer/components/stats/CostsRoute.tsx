/**
 * Costs: stacked daily cost line chart by provider + total card.
 */

import { useEffect, useMemo } from "react";
import { Line } from "react-chartjs-2";
import { baseChartOptions, bucketLabels, chartColors, formatUsd, useChartThemeKey, withAlpha } from "../../lib/chart";
import "../../lib/chart";
import type { CostsData } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ChartBox, MetricCard, MetricGrid, RouteFrame, SectionTitle, type StatsRange } from "./shared";

export function CostsRoute({ range, refreshKey }: { range: StatsRange; refreshKey: number }) {
	const t = useT();
	const themeKey = useChartThemeKey();
	const locale = uiLocale();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, refetch } = useStats<CostsData>("/api/stats/costs", params);

	useEffect(() => {
		if (refreshKey > 0) refetch();
	}, [refreshKey, refetch]);

	const stats = data;
	const series = stats?.costSeries ?? [];
	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey repaints the series colors on a theme switch.
	const { total, chart } = useMemo(() => {
		const colors = chartColors();
		const sum = series.reduce((acc, point) => acc + point.cost, 0);
		const providers = [...new Set(series.map(point => point.provider))].sort();
		const timestamps = [...new Set(series.map(point => point.timestamp))].sort((a, b) => a - b);
		return {
			total: sum,
			chart: {
				labels: bucketLabels(timestamps, locale),
				datasets: providers.map((provider, index) => ({
					label: provider,
					data: timestamps.map(ts =>
						series
							.filter(point => point.timestamp === ts && point.provider === provider)
							.reduce((acc, point) => acc + point.cost, 0),
					),
					borderColor: colors[index % colors.length],
					backgroundColor: withAlpha(colors[index % colors.length], 0.15),
					fill: true,
					stacked: true,
					tension: 0.3,
					pointRadius: 0,
					borderWidth: 1.5,
				})),
			},
		};
	}, [series, locale, themeKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey re-reads the axis tokens on a theme switch.
	const options = useMemo(() => {
		const base = baseChartOptions();
		return {
			...base,
			scales: {
				x: { ...base.scales.x, stacked: true },
				y: {
					...base.scales.y,
					stacked: true,
					ticks: { ...base.scales.y.ticks, callback: (value: number | string) => formatUsd(Number(value)) },
				},
			},
		};
	}, [themeKey]);

	return (
		<RouteFrame
			hasData={data !== null}
			empty={series.length === 0}
			error={error}
			loading={isLoading}
			onRetry={refetch}
		>
			<MetricGrid>
				<MetricCard label={t("stats.costs.totalCost")} tone="accent" value={formatUsd(total)} />
				<MetricCard
					label={t("stats.col.requests")}
					value={series.reduce((acc, point) => acc + point.requests, 0).toLocaleString(uiLocale())}
				/>
				<MetricCard
					label={t("stats.costs.outputCost")}
					value={formatUsd(series.reduce((acc, point) => acc + point.costOutput, 0))}
				/>
				<MetricCard
					label={t("stats.costs.cacheCost")}
					value={formatUsd(series.reduce((acc, point) => acc + point.costCacheRead + point.costCacheWrite, 0))}
				/>
			</MetricGrid>
			<SectionTitle>{t("stats.costs.dailyByProvider")}</SectionTitle>
			<ChartBox height={280}>
				<Line data={chart} options={options} />
			</ChartBox>
		</RouteFrame>
	);
}
