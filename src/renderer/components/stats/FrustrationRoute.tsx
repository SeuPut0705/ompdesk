/**
 * Frustration: how often user messages sound annoyed, overall and per model
 * version (`GET /api/stats/frustration`). Read-only — the paid LLM judge run
 * stays in the `omp stats` web dashboard.
 */

import { useMemo } from "react";
import type { FrustrationData, FrustrationModelRow } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { formatPercent, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
	MetricCard,
	MetricGrid,
	RouteFrame,
	SectionTitle,
	type StatColumn,
	type StatsRange,
	StatTable,
} from "./shared";

function rate(part: number, whole: number): string {
	return whole > 0 ? formatPercent((part / whole) * 100) : "—";
}

export function FrustrationRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, serverDown, refetch } = useStats<FrustrationData>("/api/stats/frustration", params);

	const overall = data?.overall;
	const rows = useMemo(() => [...(data?.byModel ?? [])].sort((a, b) => b.messages - a.messages), [data]);

	const columns: StatColumn<FrustrationModelRow>[] = useMemo(
		() => [
			{
				key: "model",
				label: t("stats.col.model"),
				render: row => (
					<span>
						<span className="block font-medium text-(--sc-text)">{row.label}</span>
						{row.models.length > 1 && (
							<span className="block font-mono text-sc-2xs text-(--sc-text-subtle)">
								{row.models.join(", ")}
							</span>
						)}
					</span>
				),
			},
			{ key: "messages", label: t("stats.col.messages"), align: "right", render: row => formatTokens(row.messages) },
			{
				key: "annoyed",
				label: t("stats.frustration.annoyed"),
				align: "right",
				render: row => rate(row.annoyed, row.messages),
			},
			{
				key: "atAssistant",
				label: t("stats.frustration.atAssistant"),
				align: "right",
				render: row => rate(row.atAssistant, row.messages),
			},
			{
				key: "angry",
				label: t("stats.frustration.angry"),
				align: "right",
				render: row =>
					row.angry > 0 ? (
						<span className="text-(--sc-warning)">{rate(row.angry, row.messages)}</span>
					) : (
						<span className="text-(--sc-text-subtle)">{rate(0, row.messages)}</span>
					),
			},
			{
				key: "judged",
				label: t("stats.frustration.judged"),
				align: "right",
				render: row => rate(row.judged, row.messages),
			},
		],
		[t],
	);

	return (
		<RouteFrame
			hasData={data !== null}
			empty={!overall || overall.messages === 0}
			error={error}
			serverDown={serverDown}
			loading={isLoading}
			onRetry={refetch}
		>
			{overall && (
				<>
					<MetricGrid>
						<MetricCard label={t("stats.col.messages")} tone="accent" value={formatTokens(overall.messages)} />
						<MetricCard
							label={t("stats.frustration.annoyed")}
							sub={formatTokens(overall.annoyed)}
							value={rate(overall.annoyed, overall.messages)}
						/>
						<MetricCard
							label={t("stats.frustration.atAssistant")}
							sub={formatTokens(overall.atAssistant)}
							value={rate(overall.atAssistant, overall.messages)}
						/>
						<MetricCard
							label={t("stats.frustration.angry")}
							sub={formatTokens(overall.angry)}
							tone={overall.angry > 0 ? "warning" : "default"}
							value={rate(overall.angry, overall.messages)}
						/>
					</MetricGrid>
					<p className="mt-2 text-sc-2xs text-(--sc-text-subtle)">
						{t("stats.frustration.judgedNote", {
							judged: formatTokens(overall.judged),
							messages: formatTokens(overall.messages),
						})}
					</p>
					<SectionTitle>{t("stats.frustration.byModel")}</SectionTitle>
					<StatTable columns={columns} keyFor={row => row.key} rows={rows} />
				</>
			)}
		</RouteFrame>
	);
}
