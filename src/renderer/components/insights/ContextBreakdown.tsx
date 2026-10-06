/**
 * Insights › Stats › This session: what the context window holds, per
 * category, over the provider-anchored breakdown from get_context_report
 * (the native /context). With a known window the bars are sized against it
 * so their sum (plus Free) fills it — the TUI grid's invariant. Without one
 * they show the composition of the used context and drop every percentage,
 * since there is nothing to divide by.
 */

import { useEffect, useState } from "react";
import type { RpcContextReportResult } from "../../../shared/rpc-types";
import { contextUsageView } from "../../lib/context-usage";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import { ProgressBar, Spinner } from "../common";

interface CategoryRow {
	key: string;
	tokens: number;
	color: string;
}

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
			<p className="text-sc-sm text-(--sc-danger)" role="alert">
				{t("contextReport.error")}: {error}
			</p>
		);
	}
	if (!report) return <p className="text-sc-sm text-(--sc-text-muted)">{t("contextReport.unavailable")}</p>;

	const breakdown = report.breakdown;
	const { capacityKnown, contextWindow, usedTokens } = contextUsageView(report, breakdown);
	const categories: CategoryRow[] = [];
	if (breakdown) {
		const rows: CategoryRow[] = [
			{ key: "systemPrompt", tokens: breakdown.systemPromptTokens, color: "var(--sc-accent)" },
			{ key: "systemContext", tokens: breakdown.systemContextTokens, color: "var(--sc-text-muted)" },
			{ key: "systemTools", tokens: breakdown.systemToolsTokens, color: "var(--sc-warning)" },
			{ key: "skills", tokens: breakdown.skillsTokens, color: "var(--sc-success)" },
			{ key: "messages", tokens: breakdown.messagesTokens, color: "var(--sc-info)" },
		];
		for (const row of rows) if (row.tokens > 0) categories.push(row);
		if (capacityKnown) {
			const free = contextWindow - usedTokens;
			if (free > 0) categories.push({ key: "free", tokens: free, color: "var(--sc-border-subtle)" });
		}
	}
	const usedPercent = capacityKnown ? Math.round((usedTokens / contextWindow) * 100) : 0;
	// Without a capacity the bars describe what the used context is made of
	// rather than how full it is; one denominator keeps both readings honest.
	const barDenominator = Math.max(1, capacityKnown ? contextWindow : usedTokens);

	return (
		<div className="flex flex-col gap-4 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) p-4">
			<div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<span className="min-w-0 truncate font-mono text-sc-sm text-(--sc-text-secondary)">
					{report.model || t("contextReport.noModel")}
				</span>
				<span className="shrink-0 text-sc-sm tabular-nums text-(--sc-text)">
					{breakdown
						? capacityKnown
							? t("contextReport.usedOf", {
									used: formatTokens(usedTokens),
									window: formatTokens(contextWindow),
									percent: usedPercent,
								})
							: t("contextReport.usedWithoutWindow", { used: formatTokens(usedTokens) })
						: capacityKnown
							? formatTokens(contextWindow)
							: t("contextReport.windowUnknown")}
				</span>
			</div>
			{breakdown && (
				<>
					<ul className="flex flex-col gap-2.5">
						{categories.map(row => {
							const fraction = row.tokens / barDenominator;
							return (
								<li className="flex items-center gap-3" key={row.key}>
									<span className="w-32 shrink-0 truncate text-sc-sm text-(--sc-text-secondary)">
										{t(`contextReport.cat.${row.key}`)}
									</span>
									<ProgressBar
										className="flex-1"
										color={row.color}
										height={8}
										value={fraction}
										valueText={
											capacityKnown
												? `${formatTokens(row.tokens)} · ${Math.round(fraction * 100)}%`
												: formatTokens(row.tokens)
										}
									/>
								</li>
							);
						})}
					</ul>
					<p className="text-sc-xs text-(--sc-text-muted)">
						{breakdown.anchored ? t("contextReport.anchored") : t("contextReport.estimated")}
					</p>
				</>
			)}
		</div>
	);
}
