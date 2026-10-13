/**
 * Providers: token-share pie chart, hourly burn histogram, and per-provider
 * aggregate table with usage-window insights.
 */

import { useMemo } from "react";
import { Bar, Pie } from "react-chartjs-2";
import { baseChartOptions, chartColors, compact, formatUsd, useChartThemeKey, withAlpha } from "../../lib/chart";
import "../../lib/chart";
import type { ProviderRow, ProvidersData, ProviderWindowsData, WindowInsight } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { useT } from "../../lib/i18n";
import { ChartBox, RouteFrame, SectionTitle, type StatColumn, type StatsRange, StatTable } from "./shared";

export function ProvidersRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const themeKey = useChartThemeKey();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, serverDown, refetch } = useStats<ProvidersData>("/api/stats/providers", params);
	const windows = useStats<ProviderWindowsData>("/api/stats/provider-windows", params);
	const stats = data;
	const windowInsights = windows.data?.windowInsights ?? [];

	const columns: StatColumn<ProviderRow>[] = useMemo(
		() => [
			{
				key: "provider",
				label: t("stats.col.provider"),
				render: row => <span className="font-medium text-(--sc-text)">{row.provider}</span>,
			},
			{ key: "requests", label: t("stats.col.requests"), align: "right", render: row => compact(row.totalRequests) },
			{ key: "models", label: t("stats.models"), align: "right", render: row => row.models },
			{ key: "tokens", label: t("stats.col.tokens"), align: "right", render: row => compact(row.totalTokens) },
			{ key: "cost", label: t("stats.col.cost"), align: "right", render: row => formatUsd(row.totalCost) },
			{
				key: "speed",
				label: t("stats.col.tps"),
				align: "right",
				render: row => (row.avgTokensPerSecond !== null ? Math.round(row.avgTokensPerSecond) : "—"),
			},
		],
		[t],
	);

	const insightColumns: StatColumn<WindowInsight>[] = useMemo(
		() => [
			{
				key: "provider",
				label: t("stats.col.provider"),
				render: row => <span className="font-medium text-(--sc-text)">{row.provider}</span>,
			},
			{ key: "window", label: t("stats.providers.col.window"), render: row => row.windowLabel },
			{ key: "accounts", label: t("stats.providers.col.accounts"), align: "right", render: row => row.accounts },
			{ key: "cycles", label: t("stats.providers.col.resets"), align: "right", render: row => row.cycles },
			{
				key: "consumed",
				label: t("stats.providers.col.consumed"),
				align: "right",
				render: row => `${row.fractionConsumed.toFixed(2)}×`,
			},
			{
				key: "perWindow",
				label: t("stats.providers.col.perWindow"),
				align: "right",
				render: row => (row.estTokensPerWindow !== null ? compact(row.estTokensPerWindow) : "—"),
			},
			{ key: "ideal", label: t("stats.providers.col.ideal"), align: "right", render: row => row.idealAccounts },
			{
				key: "exhausted",
				label: t("stats.providers.col.exhausted"),
				align: "right",
				render: row =>
					row.exhaustedEvents > 0 ? <span className="text-(--sc-danger)">{row.exhaustedEvents}</span> : "0",
			},
		],
		[t],
	);

	const providers = useMemo(
		() => [...(stats?.providers ?? [])].sort((a, b) => b.totalTokens - a.totalTokens),
		[stats],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey repaints the series colors on a theme switch.
	const pie = useMemo(() => {
		const colors = chartColors();
		return {
			labels: providers.map(row => row.provider),
			datasets: [
				{
					data: providers.map(row => row.totalTokens),
					backgroundColor: providers.map((_, index) => withAlpha(colors[index % colors.length], 0.8)),
					borderColor: "transparent",
					hoverOffset: 6,
				},
			],
		};
	}, [providers, themeKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey re-reads the axis tokens on a theme switch.
	const pieOptions = useMemo(() => {
		const base = baseChartOptions();
		return {
			maintainAspectRatio: false,
			responsive: true,
			animation: base.animation,
			plugins: {
				legend: { ...base.plugins.legend, position: "right" as const },
				tooltip: base.plugins.tooltip,
			},
		};
	}, [themeKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey repaints the series colors on a theme switch.
	const hourly = useMemo(() => {
		const colors = chartColors();
		const hours = Array.from({ length: 24 }, (_, hour) => hour);
		const byProvider = new Map<string, number[]>();
		for (const point of stats?.hourly ?? []) {
			const series = byProvider.get(point.provider) ?? Array.from({ length: 24 }, () => 0);
			series[point.hour] += point.totalTokens;
			byProvider.set(point.provider, series);
		}
		const top = [...byProvider.entries()]
			.sort(([, a], [, b]) => b.reduce((sum, value) => sum + value, 0) - a.reduce((sum, value) => sum + value, 0))
			.slice(0, 4);
		return {
			labels: hours.map(hour => `${hour}`),
			datasets: top.map(([provider, series], index) => ({
				label: provider,
				data: series,
				backgroundColor: withAlpha(colors[index % colors.length], 0.53),
				borderColor: colors[index % colors.length],
				borderWidth: 1,
			})),
		};
	}, [stats, themeKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey re-reads the axis tokens on a theme switch.
	const hourlyOptions = useMemo(() => {
		const base = baseChartOptions();
		return {
			...base,
			scales: {
				...base.scales,
				x: { ...base.scales.x, stacked: true },
				y: {
					...base.scales.y,
					stacked: true,
					ticks: { ...base.scales.y.ticks, callback: (value: number | string) => compact(Number(value)) },
				},
			},
		};
	}, [themeKey]);

	return (
		<RouteFrame
			hasData={data !== null}
			empty={providers.length === 0}
			error={error}
			serverDown={serverDown}
			loading={isLoading}
			onRetry={refetch}
		>
			<div className="grid gap-3 xl:grid-cols-2">
				<div>
					<SectionTitle>{t("stats.providers.tokenShare")}</SectionTitle>
					<ChartBox height={230}>
						<Pie data={pie} options={pieOptions} />
					</ChartBox>
				</div>
				<div>
					<SectionTitle>{t("stats.providers.peakBurn")}</SectionTitle>
					<ChartBox height={230}>
						<Bar data={hourly} options={hourlyOptions} />
					</ChartBox>
				</div>
			</div>
			<SectionTitle>{t("stats.providers")}</SectionTitle>
			<StatTable columns={columns} keyFor={row => row.provider} rows={providers} />
			{windowInsights.length > 0 && (
				<>
					<SectionTitle>{t("stats.providers.windows")}</SectionTitle>
					<StatTable
						columns={insightColumns}
						keyFor={row => `${row.provider}/${row.windowKey}`}
						rows={windowInsights}
					/>
				</>
			)}
		</RouteFrame>
	);
}
