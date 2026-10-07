/**
 * Insights › Stats › This session: what the context window holds, per
 * category, over the provider-anchored breakdown from get_context_report
 * (the native /context). One stacked bar shows the whole window; the legend
 * under it lists each category with tokens and share in fixed columns, so
 * the figures line up instead of bending each row's own bar. With a known
 * window the segments are sized against it so their sum (plus Free) fills
 * it — the TUI grid's invariant. Without one they show the composition of
 * the used context and drop every percentage, since there is nothing to
 * divide by.
 */

import { useEffect, useState } from "react";
import type { RpcContextReportResult } from "../../../shared/rpc-types";
import { contextUsageView } from "../../lib/context-usage";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { Banner, ErrorDetail, Spinner } from "../common";

interface CategoryRow {
	key: string;
	tokens: number;
	color: string;
}

/** Category hues — semantic and syntax tokens, so every theme retints them. Free is the bare track. */
const CATEGORY_COLOR: Record<string, string> = {
	systemPrompt: "var(--sc-accent)",
	systemContext: "var(--omp-syntax-number)",
	systemTools: "var(--sc-warning)",
	skills: "var(--sc-success)",
	messages: "var(--sc-info)",
	free: "var(--sc-surface-3)",
};

export function ContextBreakdown({ refreshKey = 0 }: { refreshKey?: number }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const [report, setReport] = useState<RpcContextReportResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the explicit re-read trigger.
	useEffect(() => {
		let cancelled = false;
		setError(null);
		setLoading(true);
		void tabRpc
			.getContextReport()
			.then(response => {
				if (cancelled) return;
				if (response.success) setReport(response.data as RpcContextReportResult);
				else setError(response.error);
			})
			.catch(cause => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [tabRpc.getContextReport, refreshKey]);

	if (loading && !report) {
		return (
			<div className="flex justify-center py-6">
				<Spinner label={t("contextReport.loading")} />
			</div>
		);
	}
	if (error) {
		return (
			<Banner live title={t("contextReport.error")} variant="warning">
				<ErrorDetail error={error} />
			</Banner>
		);
	}
	if (!report) return <p className="text-sc-sm text-(--sc-text-muted)">{t("contextReport.unavailable")}</p>;

	const breakdown = report.breakdown;
	const { capacityKnown, contextWindow, usedTokens } = contextUsageView(report, breakdown);
	const categories: CategoryRow[] = [];
	if (breakdown) {
		const rows: Array<[string, number]> = [
			["systemPrompt", breakdown.systemPromptTokens],
			["systemContext", breakdown.systemContextTokens],
			["systemTools", breakdown.systemToolsTokens],
			["skills", breakdown.skillsTokens],
			["messages", breakdown.messagesTokens],
		];
		for (const [key, tokens] of rows) if (tokens > 0) categories.push({ key, tokens, color: CATEGORY_COLOR[key] });
		if (capacityKnown) {
			const free = contextWindow - usedTokens;
			if (free > 0) categories.push({ key: "free", tokens: free, color: CATEGORY_COLOR.free });
		}
	}
	const usedPercent = capacityKnown ? Math.round((usedTokens / contextWindow) * 100) : 0;
	// Without a capacity the bars describe what the used context is made of
	// rather than how full it is; one denominator keeps both readings honest.
	const barDenominator = Math.max(1, capacityKnown ? contextWindow : usedTokens);
	const filled = categories.filter(row => row.key !== "free");
	const percentOf = (tokens: number) => {
		const percent = (tokens / barDenominator) * 100;
		return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
	};
	const summary = breakdown
		? capacityKnown
			? t("contextReport.usedOf", {
					used: formatTokens(usedTokens),
					window: formatTokens(contextWindow),
					percent: usedPercent,
				})
			: t("contextReport.usedWithoutWindow", { used: formatTokens(usedTokens) })
		: capacityKnown
			? formatTokens(contextWindow)
			: t("contextReport.windowUnknown");

	return (
		<div className="flex flex-col gap-4 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-4">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<span className="min-w-0 truncate font-mono text-sc-sm text-(--sc-text-secondary)">
					{report.model || t("contextReport.noModel")}
				</span>
				<span className="shrink-0 text-sc-sm font-medium tabular-nums text-(--sc-text)">{summary}</span>
			</div>
			{breakdown && (
				<>
					<div
						aria-label={summary}
						className="flex h-2.5 w-full gap-px overflow-hidden rounded-(--sc-radius-full) bg-(--sc-surface-3)"
						role="img"
					>
						{filled.map(row => (
							<span
								className="h-full min-w-0.5 transition-[width] duration-(--sc-duration-med)"
								key={row.key}
								style={{ width: `${(row.tokens / barDenominator) * 100}%`, backgroundColor: row.color }}
							/>
						))}
					</div>
					<ul className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 text-sc-sm">
						{categories.map(row => (
							<li className="col-span-4 grid grid-cols-subgrid items-center" key={row.key}>
								<span
									aria-hidden
									className="size-2.5 rounded-(--sc-radius-xs) border border-(--sc-border-subtle)"
									style={{ backgroundColor: row.color }}
								/>
								<span className="truncate text-(--sc-text-secondary)">{t(`contextReport.cat.${row.key}`)}</span>
								<span className="text-right tabular-nums text-(--sc-text)">{formatTokens(row.tokens)}</span>
								<span className="w-10 text-right tabular-nums text-(--sc-text-muted)">
									{capacityKnown ? percentOf(row.tokens) : ""}
								</span>
							</li>
						))}
					</ul>
					<p className="text-sc-xs text-(--sc-text-muted)">
						{breakdown.anchored ? t("contextReport.anchored") : t("contextReport.estimated")}
					</p>
				</>
			)}
		</div>
	);
}
