/**
 * Tools: ranked usage table with error rate and attributed cost, plus a
 * top-tools call-volume bar chart.
 */

import { useMemo } from "react";
import { Bar } from "react-chartjs-2";
import { baseChartOptions, chartColors, compact, useChartThemeKey, withAlpha } from "../../lib/chart";
import "../../lib/chart";
import type { ToolRow, ToolsData } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { formatUsd, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Badge } from "../common";
import { ChartBox, RouteFrame, SectionTitle, type StatColumn, type StatsRange, StatTable } from "./shared";

export function ToolsRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const themeKey = useChartThemeKey();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, serverDown, refetch } = useStats<ToolsData>("/api/stats/tools", params);

	const stats = data;

	const columns: StatColumn<ToolRow>[] = useMemo(
		() => [
			{
				key: "tool",
				label: t("stats.tools.col.tool"),
				render: row => <span className="font-mono font-medium text-(--sc-text)">{row.tool}</span>,
			},
			{ key: "calls", label: t("stats.tools.col.calls"), align: "right", render: row => compact(row.calls) },
			{
				key: "errors",
				label: t("stats.col.errors"),
				align: "right",
				render: row =>
					row.errors > 0 ? (
						<Badge variant="error">{compact(row.errors)}</Badge>
					) : (
						<span className="text-(--sc-text-subtle)">0</span>
					),
			},
			{ key: "args", label: t("stats.tools.col.args"), align: "right", render: row => compact(row.argsChars) },
			{ key: "result", label: t("stats.tools.col.result"), align: "right", render: row => compact(row.resultChars) },
			{
				key: "tokens",
				label: t("stats.tools.col.tokensShare"),
				align: "right",
				render: row => compact(row.totalTokensShare),
			},
			{
				key: "cost",
				label: t("stats.tools.col.costShare"),
				align: "right",
				render: row => formatUsd(row.costShare),
			},
			{
				key: "last",
				label: t("stats.tools.col.last"),
				align: "right",
				render: row =>
					row.lastUsed > 0
						? new Date(row.lastUsed).toLocaleString(uiLocale(), {
								month: "short",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							})
						: t("stats.tools.never"),
			},
		],
		[t],
	);

	const byTool = useMemo(() => [...(stats?.byTool ?? [])].sort((a, b) => b.calls - a.calls), [stats]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey repaints the series colors on a theme switch.
	const barChart = useMemo(() => {
		const colors = chartColors();
		const top = byTool.slice(0, 12);
		return {
			labels: top.map(row => row.tool),
			datasets: [
				{
					label: t("stats.tools.col.calls"),
					data: top.map(row => row.calls),
					backgroundColor: top.map((_, index) => withAlpha(colors[index % colors.length], 0.6)),
					borderColor: top.map((_, index) => colors[index % colors.length]),
					borderWidth: 1,
				},
			],
		};
	}, [byTool, t, themeKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey re-reads the axis tokens on a theme switch.
	const barOptions = useMemo(() => {
		const base = baseChartOptions();
		const mono = getComputedStyle(document.documentElement).getPropertyValue("--sc-font-mono").trim() || "monospace";
		return {
			...base,
			indexAxis: "y" as const,
			plugins: { ...base.plugins, legend: { display: false } },
			scales: {
				x: { ...base.scales.x },
				y: {
					...base.scales.y,
					ticks: { ...base.scales.y.ticks, font: { ...base.scales.y.ticks.font, family: mono } },
				},
			},
		};
	}, [themeKey]);

	return (
		<RouteFrame
			hasData={data !== null}
			empty={byTool.length === 0}
			error={error}
			serverDown={serverDown}
			loading={isLoading}
			onRetry={refetch}
		>
			<SectionTitle>{t("stats.tools.callVolume")}</SectionTitle>
			<ChartBox height={Math.max(180, byTool.slice(0, 12).length * 26)}>
				<Bar data={barChart} options={barOptions} />
			</ChartBox>
			<SectionTitle>{t("stats.tools.allTools")}</SectionTitle>
			<StatTable columns={columns} keyFor={row => row.tool} rows={byTool} />
		</RouteFrame>
	);
}
