/**
 * Projects: per-folder usage breakdown with share bars.
 */

import { useEffect, useMemo } from "react";
import type { FolderRow } from "../../../shared/stats-types";
import { useStatsList } from "../../hooks/use-stats";
import { compact, formatUsd } from "../../lib/chart";
import { useT } from "../../lib/i18n";
import { ProgressBar } from "../common";
import { RouteFrame, SectionTitle, type StatColumn, type StatsRange, StatTable } from "./shared";

export function ProjectsRoute({ range, refreshKey }: { range: StatsRange; refreshKey: number }) {
	const t = useT();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, refetch } = useStatsList<FolderRow>("/api/stats/folders", params);

	useEffect(() => {
		if (refreshKey > 0) refetch();
	}, [refreshKey, refetch]);

	const rows = useMemo(() => {
		const list = data ?? [];
		return [...list].sort((a, b) => b.totalCost - a.totalCost);
	}, [data]);

	const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);

	const columns: StatColumn<FolderRow>[] = useMemo(
		() => [
			{
				key: "folder",
				label: t("stats.col.project"),
				render: row => (
					<span className="font-mono text-(--sc-text)">{row.folder || t("stats.projects.unknown")}</span>
				),
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
			{
				key: "share",
				label: t("stats.projects.col.share"),
				render: row => {
					const fraction = totalCost > 0 ? row.totalCost / totalCost : 0;
					return (
						<ProgressBar
							className="w-28"
							color="var(--sc-accent)"
							value={fraction}
							valueText={`${(fraction * 100).toFixed(0)}%`}
						/>
					);
				},
			},
			{
				key: "speed",
				label: t("stats.col.tps"),
				align: "right",
				render: row => (row.avgTokensPerSecond !== null ? Math.round(row.avgTokensPerSecond) : "—"),
			},
		],
		[totalCost, t],
	);

	return (
		<RouteFrame hasData={data !== null} empty={rows.length === 0} error={error} loading={isLoading} onRetry={refetch}>
			<SectionTitle>{t("stats.projects.sectionTitle", { count: rows.length })}</SectionTitle>
			<StatTable columns={columns} keyFor={row => row.folder} rows={rows} />
		</RouteFrame>
	);
}
