/**
 * Requests: paginated table of recent requests with a detail drawer that
 * fetches /api/request/:id on row click.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RequestDetail, RequestPage, RequestRow } from "../../../shared/stats-types";
import { useStats } from "../../hooks/use-stats";
import { compact, formatMs } from "../../lib/chart";
import { inlineFailure } from "../../lib/error-detail";
import { formatUsd, uiLocale } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useFocusedTabDevice } from "../../stores/remote";
import { Badge, Button, ErrorDetail, Sheet, Spinner } from "../common";
import { projectLabel } from "./ProjectsRoute";
import { RouteFrame, SectionTitle, type StatColumn, type StatsRange, StatTable, stopReasonLabel } from "./shared";

const PAGE_SIZE = 25;
/** Request detail sheet; keeps the last row mounted while the sheet animates closed. */
function RequestDetailSheet({ row, onClose }: { row: RequestRow | null; onClose: () => void }) {
	const [shown, setShown] = useState(row);
	if (row && row !== shown) setShown(row);
	return (
		<Sheet
			description={shown ? new Date(shown.timestamp).toLocaleString(uiLocale()) : undefined}
			onClose={onClose}
			open={row !== null}
			size="lg"
			title={shown?.model ?? ""}
		>
			{shown && <RequestDetailBody row={shown} />}
		</Sheet>
	);
}

function RequestDetailBody({ row }: { row: RequestRow }) {
	const t = useT();
	const device = useFocusedTabDevice();
	const [detail, setDetail] = useState<RequestDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (row.id === undefined) {
			setDetail(null);
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		window.omp.stats
			.fetch(`/api/request/${row.id}`, undefined, device)
			.then(result => {
				if (result && typeof result === "object" && "error" in result) throw new Error(String(result.error));
				if (!cancelled) setDetail(result as RequestDetail);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [device, row.id]);

	return (
		<>
			<dl className="mb-4 grid grid-cols-2 gap-2">
				{[
					[t("stats.col.provider"), row.provider],
					[t("stats.requests.detail.api"), row.api],
					[t("stats.requests.detail.stopReason"), stopReasonLabel(t, row)],
					[t("stats.col.duration"), formatMs(row.duration)],
					[t("stats.col.ttft"), formatMs(row.ttft)],
					[t("stats.col.cost"), formatUsd(row.usage?.cost?.total ?? 0)],
					[t("stats.requests.detail.input"), compact(row.usage?.input ?? 0)],
					[t("stats.requests.detail.output"), compact(row.usage?.output ?? 0)],
					[t("stats.requests.detail.cacheRead"), compact(row.usage?.cacheRead ?? 0)],
					[t("stats.requests.detail.cacheWrite"), compact(row.usage?.cacheWrite ?? 0)],
				].map(([label, value]) => (
					<div className="rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2" key={label}>
						<dt className="text-sc-xs text-(--sc-text-muted)">{label}</dt>
						<dd className="mt-0.5 truncate text-sc-sm tabular-nums text-(--sc-text)">{value}</dd>
					</div>
				))}
			</dl>
			{row.errorMessage && (
				<div className="mb-4 rounded-(--sc-radius-md) bg-(--sc-danger-soft) px-3 py-2 font-mono text-sc-xs break-words text-(--sc-danger-on-soft)">
					{row.errorMessage}
				</div>
			)}
			<SectionTitle>{t("stats.requests.payload")}</SectionTitle>
			{loading ? (
				<div className="flex items-center gap-2 py-4">
					<Spinner size="sm" />
					<span className="text-sc-xs text-(--sc-text-subtle)">{t("stats.requests.loadingDetail")}</span>
				</div>
			) : error ? (
				<div className="text-sc-xs text-(--sc-danger)" role="alert">
					{inlineFailure(error, t("stats.requests.detailFailed")).message}
					<ErrorDetail className="mt-0.5" error={error} />
				</div>
			) : (
				<pre className="max-h-[45vh] overflow-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-1) p-3 font-mono text-sc-xs break-words whitespace-pre-wrap text-(--sc-text-muted)">
					{JSON.stringify({ messages: detail?.messages, output: detail?.output }, null, 2)?.slice(0, 40_000) ??
						t("stats.requests.emptyPayload")}
				</pre>
			)}
		</>
	);
}

export function RequestsRoute({ range }: { range: StatsRange }) {
	const t = useT();
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const page = cursors.length - 1;
	const cursor = cursors[page];
	const params = useMemo(() => ({ range, limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) }), [range, cursor]);
	const { data, isLoading, error, serverDown, refetch } = useStats<RequestPage>("/api/stats/requests", params);
	const [selected, setSelected] = useState<RequestRow | null>(null);

	const rows = data?.rows ?? [];
	const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

	const columns: StatColumn<RequestRow>[] = useMemo(
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
							second: "2-digit",
						})}
					</span>
				),
			},
			{
				key: "model",
				label: t("stats.col.model"),
				render: row => (
					<span>
						<span className="block font-mono whitespace-nowrap text-(--sc-text)">{row.model}</span>
						<span className="block text-sc-2xs text-(--sc-text-subtle)">{row.provider}</span>
					</span>
				),
			},
			{
				key: "status",
				label: t("stats.col.status"),
				render: row => <Badge variant={row.errorMessage ? "error" : "success"}>{stopReasonLabel(t, row)}</Badge>,
			},
			{ key: "duration", label: t("stats.col.duration"), align: "right", render: row => formatMs(row.duration) },
			{ key: "ttft", label: t("stats.col.ttft"), align: "right", render: row => formatMs(row.ttft) },
			{
				key: "tokens",
				label: t("stats.col.tokens"),
				align: "right",
				render: row => compact(row.usage?.totalTokens ?? 0),
			},
			{
				key: "cost",
				label: t("stats.col.cost"),
				align: "right",
				render: row => formatUsd(row.usage?.cost?.total ?? 0),
			},
			{
				key: "folder",
				label: t("stats.col.project"),
				render: row => (
					<span className="text-sc-2xs break-all text-(--sc-text-subtle)" title={row.folder}>
						{projectLabel(row.folder)}
					</span>
				),
			},
		],
		[t],
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
			<SectionTitle>
				{t("stats.requests.sectionTitle", { count: (data?.total ?? 0).toLocaleString(uiLocale()) })}
			</SectionTitle>
			<StatTable
				columns={columns}
				keyFor={row => `${row.id ?? row.entryId}-${row.timestamp}`}
				onRowClick={setSelected}
				rows={rows}
			/>
			<div className="mt-2 flex items-center justify-end">
				<div className="flex items-center gap-1.5">
					<Button
						disabled={page === 0 || isLoading}
						icon={<ChevronLeft size={11} />}
						onClick={() => {
							setSelected(null);
							setCursors(previous => previous.slice(0, -1));
						}}
						size="sm"
						variant="ghost"
					>
						{t("stats.requests.prev")}
					</Button>
					<span className="text-sc-2xs tabular-nums text-(--sc-text-muted)">
						{t("stats.requests.page", { page: page + 1, pages })}
					</span>
					<Button
						disabled={!data?.nextCursor || isLoading}
						onClick={() => {
							if (data?.nextCursor) {
								setSelected(null);
								setCursors(previous => [...previous, data.nextCursor]);
							}
						}}
						size="sm"
						trailingIcon={<ChevronRight size={11} />}
						variant="ghost"
					>
						{t("stats.requests.next")}
					</Button>
				</div>
			</div>
			<RequestDetailSheet onClose={() => setSelected(null)} row={selected} />
		</RouteFrame>
	);
}
