/**
 * Errors: failed requests with messages, newest first.
 */

import { useMemo } from "react";
import type { ErrorRow } from "../../../shared/stats-types";
import { useStatsList } from "../../hooks/use-stats";
import { compact } from "../../lib/chart";
import { uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Badge } from "../common";
import { RouteFrame, SectionTitle, type StatColumn, type StatsRange, StatTable } from "./shared";

export function ErrorsRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const params = useMemo(() => ({ range, limit: "100" }), [range]);
	const { data, isLoading, error, refetch } = useStatsList<ErrorRow>("/api/stats/errors", params);

	const rows = useMemo(() => {
		const list = data ?? [];
		return [...list].sort((a, b) => b.timestamp - a.timestamp);
	}, [data]);

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
					<span>
						<span className="block font-mono text-(--sc-text)">{row.model}</span>
						<span className="block text-sc-2xs text-(--sc-text-subtle)">{row.provider}</span>
					</span>
				),
			},
			{
				key: "reason",
				label: t("stats.errors.col.stop"),
				render: row => <Badge variant="error">{row.stopReason || "error"}</Badge>,
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
		[t],
	);

	return (
		<RouteFrame hasData={data !== null} empty={rows.length === 0} error={error} loading={isLoading} onRetry={refetch}>
			<SectionTitle>{t("stats.errors.sectionTitle", { count: rows.length })}</SectionTitle>
			<StatTable columns={columns} keyFor={row => `${row.id ?? row.entryId ?? row.timestamp}`} rows={rows} />
		</RouteFrame>
	);
}
