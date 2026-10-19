/**
 * Projects: per-folder usage breakdown with share bars.
 */

import { useMemo } from "react";
import type { FolderRow } from "../../../shared/stats-types";
import { useStatsList } from "../../hooks/use-stats";
import { compact } from "../../lib/chart";
import { formatUsd } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ProgressBar } from "../common";
import { RouteFrame, SectionTitle, type StatColumn, type StatsRange, StatTable } from "./shared";

/**
 * A stats folder made readable. Stock writes either a path (`/private-tmp/`)
 * or a session dir name from pi-coding-agent `session/session-paths.ts`
 * (`getDefaultSessionDirName`: `-Desktop-GitHub-omgdesk` for ~/Desktop/GitHub/omgdesk).
 * That encoding turns both "/" and "-" into "-" and stock has no decoder, so
 * the segments cannot be recovered safely ("rng-arena" would read as "arena"):
 * a path keeps its last segment; a dir name only loses its scope dashes.
 * The raw value stays in the tooltip.
 */
export function projectLabel(folder: string): string {
	if (folder.includes("/")) return folder.split("/").filter(Boolean).at(-1) ?? folder;
	return folder.replace(/^-+|-+$/g, "") || folder;
}
export function ProjectsRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, serverDown, refetch } = useStatsList<FolderRow>("/api/stats/folders", params);

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
				render: row =>
					row.folder ? (
						<span className="font-mono break-all text-(--sc-text)" title={row.folder}>
							{projectLabel(row.folder)}
						</span>
					) : (
						<span className="text-(--sc-text-muted)">{t("stats.projects.unknown")}</span>
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
		<RouteFrame
			hasData={data !== null}
			empty={rows.length === 0}
			error={error}
			serverDown={serverDown}
			loading={isLoading}
			onRetry={refetch}
		>
			<SectionTitle>{t("stats.projects.sectionTitle", { count: rows.length })}</SectionTitle>
			<StatTable columns={columns} keyFor={row => row.folder} rows={rows} />
		</RouteFrame>
	);
}
