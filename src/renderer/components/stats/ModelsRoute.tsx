/**
 * Models: usage bar chart, performance series, and per-model table.
 */

import { useEffect, useMemo } from "react";
import { Bar, Line } from "react-chartjs-2";
import { baseChartOptions, bucketLabels, CHART_COLORS, compact, formatMs, formatUsd } from "../../lib/chart";
import "../../lib/chart";
import type { ModelRow, ModelsData } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { useT } from "../../lib/i18n";
import type { StatsRange } from "./StatsDashboard";
import { ChartBox, RouteFrame, SectionTitle, type StatColumn, StatTable } from "./shared";

const tokenCountFormatter = new Intl.NumberFormat("en-US");

export function ModelsRoute({ range, refreshKey }: { range: StatsRange; refreshKey: number }) {
	const t = useT();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, refetch } = useStats<ModelsData>("/api/stats/model-dashboard", params);

	useEffect(() => {
		if (refreshKey > 0) refetch();
	}, [refreshKey, refetch]);

	const stats = data;

	const columns: StatColumn<ModelRow>[] = useMemo(
		() => [
			{
				key: "model",
				label: t("stats.col.model"),
				render: row => (
					<span>
						<span className="block font-mono font-medium text-(--omp-text)">{row.model}</span>
						<span className="block text-omp-xs text-(--omp-dim)">{row.provider}</span>
					</span>
				),
			},
			{ key: "requests", label: t("stats.col.requests"), align: "right", render: row => compact(row.totalRequests) },
			{
				key: "errors",
				label: t("stats.col.errors"),
				align: "right",
				render: row => (
					<span className={row.errorRate > 0.05 ? "text-(--omp-error)" : undefined}>
						{(row.errorRate * 100).toFixed(1)}%
					</span>
				),
			},
			{
				key: "inputTokens",
				label: t("stats.col.inputTokens"),
				align: "right",
				render: row => tokenCountFormatter.format(row.totalInputTokens),
			},
			{
				key: "outputTokens",
				label: t("stats.col.outputTokens"),
				align: "right",
				render: row => tokenCountFormatter.format(row.totalOutputTokens),
			},
			{
				key: "cacheReadTokens",
				label: t("stats.col.cacheReadTokens"),
				align: "right",
				render: row => tokenCountFormatter.format(row.totalCacheReadTokens),
			},
			{
				key: "cacheWriteTokens",
				label: t("stats.col.cacheWriteTokens"),
				align: "right",
				render: row => tokenCountFormatter.format(row.totalCacheWriteTokens),
			},
			{
				key: "cacheRate",
				label: t("stats.col.cacheHitRate"),
				align: "right",
				render: row => <span title={t("stats.models.cacheHitFormula")}>{(row.cacheRate * 100).toFixed(2)}%</span>,
			},
			{ key: "cost", label: t("stats.col.cost"), align: "right", render: row => formatUsd(row.totalCost) },
			{ key: "ttft", label: t("stats.col.ttft"), align: "right", render: row => formatMs(row.avgTtft) },
			{
				key: "speed",
				label: t("stats.col.tps"),
				align: "right",
				render: row => (row.avgTokensPerSecond !== null ? Math.round(row.avgTokensPerSecond) : "—"),
			},
		],
		[t],
	);

	const byModel = useMemo(
		() => [...(stats?.byModel ?? [])].sort((a, b) => b.totalRequests - a.totalRequests),
		[stats],
	);
	const usageChart = useMemo(() => {
		const top = byModel.slice(0, 10);
		return {
			labels: top.map(row => row.model),
			datasets: [
				{
					label: t("stats.col.requests"),
					data: top.map(row => row.totalRequests),
					backgroundColor: top.map((_, index) => `${CHART_COLORS[index % CHART_COLORS.length]}99`),
					borderColor: top.map((_, index) => CHART_COLORS[index % CHART_COLORS.length]),
					borderWidth: 1,
				},
			],
		};
	}, [byModel, t]);

	const perfChart = useMemo(() => {
		const points = stats?.modelPerformanceSeries ?? [];
		const topModels = byModel.slice(0, 5).map(row => row.model);
		const timestamps = [...new Set(points.map(point => point.timestamp))].sort((a, b) => a - b);
		return {
			labels: bucketLabels(timestamps),
			datasets: topModels.map((model, index) => ({
				label: model,
				data: timestamps.map(ts => {
					const point = points.find(p => p.timestamp === ts && p.model === model);
					return point?.avgTokensPerSecond ?? null;
				}),
				borderColor: CHART_COLORS[index % CHART_COLORS.length],
				backgroundColor: "transparent",
				tension: 0.3,
				pointRadius: 0,
				borderWidth: 1.5,
				spanGaps: true,
			})),
		};
	}, [stats, byModel]);

	return (
		<RouteFrame
			hasData={data !== null}
			empty={byModel.length === 0}
			error={error}
			loading={isLoading}
			onRetry={refetch}
		>
			<div className="grid gap-3 xl:grid-cols-2">
				<div>
					<SectionTitle>{t("stats.models.requestsByModel")}</SectionTitle>
					<ChartBox height={230}>
						<Bar
							data={usageChart}
							options={{
								...baseChartOptions(),
								plugins: { ...baseChartOptions().plugins, legend: { display: false } },
							}}
						/>
					</ChartBox>
				</div>
				<div>
					<SectionTitle>{t("stats.models.throughput")}</SectionTitle>
					<ChartBox height={230}>
						<Line data={perfChart} options={baseChartOptions()} />
					</ChartBox>
				</div>
			</div>
			<SectionTitle>{t("stats.models.allModels")}</SectionTitle>
			<StatTable columns={columns} keyFor={row => `${row.provider}/${row.model}`} rows={byModel} />
		</RouteFrame>
	);
}
