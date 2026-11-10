/**
 * Errors: failed requests with messages, newest first.
 */

import { useMemo } from "react";
import type { ErrorRow } from "../../../shared/stats-types";
import { useStatsList } from "../../hooks/use-stats";
import { compact } from "../../lib/chart";
import { uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Badge, SectionLabel } from "../common";
import { ModelLabel } from "../settings/ModelLabel";
import { compactModelLabels } from "../settings/providers/provider-marks";
import { RouteFrame, type StatColumn, type StatsRange, StatTable, stopReasonLabel } from "./shared";

export function ErrorsRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const params = useMemo(() => ({ range, limit: "100" }), [range]);
	const { data, isLoading, error, serverDown, refetch } = useStatsList<ErrorRow>("/api/stats/errors", params);

	const rows = useMemo(() => {
		const list = data ?? [];
		return [...list].sort((a, b) => b.timestamp - a.timestamp);
	}, [data]);
	const labels = useMemo(
		() => compactModelLabels(rows.map(row => ({ provider: row.provider, id: row.model }))),
		[rows],
	);

	const columns: StatColumn<ErrorRow>[] = useMemo(
		() => [
			{
				key: "time",
				label: t("stats.col.when"),
				render: row => (
					<span className="whitespace-nowrap text-(--sc-text-muted)">
						{new Date(row.timestamp).toLocaleString(uiLocale(), {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						})}
					</span>
				),
			},
			{
				key: "model",
				label: t("stats.col.model"),
				render: row => (
					<span title={`${row.provider}/${row.model}`}>
						<ModelLabel
							className="whitespace-nowrap text-(--sc-text)"
							provider={row.provider}
							label={labels.get(`${row.provider}/${row.model}`) ?? { name: row.model }}
						/>
						<span className="block text-sc-2xs text-(--sc-text-subtle)">{row.provider}</span>
					</span>
				),
			},
			{
				key: "reason",
				label: t("stats.errors.col.stop"),
				render: row => <Badge variant="error">{stopReasonLabel(t, row)}</Badge>,
			},
			{
				key: "message",
				label: t("stats.errors.col.message"),
				render: row => (
					<span className="block max-w-[420px] break-words font-mono text-sc-2xs leading-snug text-(--sc-danger)">
						{row.errorMessage ?? t("stats.errors.noMessage")}
					</span>
				),
			},
			{
				key: "tokens",
				label: t("stats.col.tokens"),
				align: "right",
				render: row => compact(row.usage?.totalTokens ?? 0),
			},
		],
		[t, labels],
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
			<SectionLabel className="mt-8 mb-3 first:mt-0" size="title">
				{t("stats.errors.sectionTitle", { count: rows.length })}
			</SectionLabel>
			<StatTable columns={columns} keyFor={row => `${row.id ?? row.entryId ?? row.timestamp}`} rows={rows} />
		</RouteFrame>
	);
}
