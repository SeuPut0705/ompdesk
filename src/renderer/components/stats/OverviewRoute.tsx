/**
 * Overview: headline metric cards + requests/errors time series + per-agent
 * type breakdown.
 */

import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import {
	baseChartOptions,
	bucketLabels,
	chartTheme,
	compact,
	formatMs,
	useChartThemeKey,
	withAlpha,
} from "../../lib/chart";
import "../../lib/chart";
import type { AgentTypeRow, OverviewData } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { formatUsd, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
	ChartBox,
	MetricCard,
	MetricGrid,
	RouteFrame,
	SectionTitle,
	type StatColumn,
	type StatsRange,
	StatTable,
} from "./shared";

export function OverviewRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const themeKey = useChartThemeKey();
	const locale = uiLocale();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, serverDown, refetch } = useStats<OverviewData>("/api/stats/overview", params);

	const stats = data;
	const overall = stats?.overall;
	const series = stats?.timeSeries ?? [];

	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey repaints the series colors on a theme switch.
	const activityChart = useMemo(() => {
		const theme = chartTheme();
		return {
			labels: bucketLabels(
				series.map(point => point.timestamp),
				locale,
			),
			datasets: [
				{
					label: t("stats.col.requests"),
					data: series.map(point => point.requests),
					borderColor: theme.accent,
					backgroundColor: withAlpha(theme.accent, 0.13),
					fill: true,
					tension: 0.3,
					pointRadius: 0,
					borderWidth: 1.5,
				},
				{
					label: t("stats.col.errors"),
					data: series.map(point => point.errors),
					borderColor: theme.error,
					backgroundColor: "transparent",
					tension: 0.3,
					pointRadius: 0,
					borderWidth: 1.5,
				},
			],
		};
	}, [series, locale, t, themeKey]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey re-reads the axis tokens on a theme switch.
	const chartOptions = useMemo(() => baseChartOptions(), [themeKey]);

	const agentColumns: StatColumn<AgentTypeRow>[] = useMemo(
		() => [
			{
				key: "type",
				label: t("stats.overview.col.agentType"),
				render: row => <span className="font-medium text-(--sc-text)">{row.agentType}</span>,
			},
			{ key: "requests", label: t("stats.col.requests"), align: "right", render: row => compact(row.totalRequests) },
			{
				key: "tokens",
				label: t("stats.col.tokens"),
				align: "right",
				render: row =>
					compact(
						row.totalInputTokens + row.totalOutputTokens + row.totalCacheReadTokens + row.totalCacheWriteTokens,
					),
			},
			{ key: "cost", label: t("stats.col.cost"), align: "right", render: row => formatUsd(row.totalCost) },
		],
		[t],
	);

	return (
		<RouteFrame
			hasData={data !== null}
			empty={!overall || overall.totalRequests === 0}
			error={error}
			serverDown={serverDown}
			loading={isLoading}
			onRetry={refetch}
		>
			{overall && (
				<>
					<MetricGrid>
						<MetricCard
							label={t("stats.col.requests")}
							sub={t("stats.overview.failedSub", { count: overall.failedRequests })}
							tone="accent"
							value={compact(overall.totalRequests)}
						/>
						<MetricCard
							label={t("stats.col.tokens")}
							sub={t("stats.overview.outputSub", { count: compact(overall.totalOutputTokens) })}
							value={compact(
								overall.totalInputTokens +
									overall.totalOutputTokens +
									overall.totalCacheReadTokens +
									overall.totalCacheWriteTokens,
							)}
						/>
						<MetricCard label={t("stats.col.cost")} value={formatUsd(overall.totalCost)} />
						<MetricCard
							label={t("stats.overview.errorRate")}
							tone={overall.errorRate > 0.05 ? "error" : "success"}
							value={`${(overall.errorRate * 100).toFixed(1)}%`}
						/>
						<MetricCard label={t("stats.overview.cacheHit")} value={`${(overall.cacheRate * 100).toFixed(0)}%`} />
						<MetricCard
							label={t("stats.overview.speed")}
							sub={t("stats.overview.ttftSub", { time: formatMs(overall.avgTtft) })}
							value={
								overall.avgTokensPerSecond !== null
									? t("stats.overview.tokensPerSecond", { rate: Math.round(overall.avgTokensPerSecond) })
									: "—"
							}
						/>
					</MetricGrid>

					<SectionTitle>{t("stats.overview.activity")}</SectionTitle>
					<ChartBox height={240}>
						<Line data={activityChart} options={chartOptions} />
					</ChartBox>

					<SectionTitle>{t("stats.overview.byAgentType")}</SectionTitle>
					<StatTable columns={agentColumns} keyFor={row => row.agentType} rows={stats?.byAgentType ?? []} />
				</>
			)}
		</RouteFrame>
	);
}
