/**
 * Insights › This session › "Usage by model": how the session's tokens and cost
 * split across models — the main agent's own usage (stock session stats) plus
 * every subagent's, grouped by the model it ran on. With the model pool on,
 * pool models carry their member name and role, so the distribution the pool
 * produced is visible at a glance. Renders nothing until a subagent has run.
 */
import type { SessionStats } from "../../../shared/rpc-types";
import { formatUsd } from "../../lib/chart";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isPresetRole, modelSelector, usageByModel } from "../../lib/model-pool";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { ProgressBar } from "../common";
import { SectionTitle } from "../stats/shared";

export function ModelUsage({ stats }: { stats: SessionStats }) {
	const t = useT();
	const model = useModelStore(s => s.model);
	const subagents = useSubagentsStore(s => s.subagents);
	const pool = useSessionStore(s => s.modelPool);

	const rows = usageByModel(
		model
			? {
					model: modelSelector(model),
					requests: stats.assistantMessages,
					tokens: stats.history?.totalTokens ?? stats.tokens.total,
					cost: stats.history?.cost ?? stats.cost,
				}
			: null,
		subagents.values(),
		pool,
	);
	if (!rows.some(row => !row.main)) return null;

	return (
		<section aria-labelledby="insights-model-usage">
			<SectionTitle>
				<span id="insights-model-usage">{t("modelPool.usageTitle")}</span>
			</SectionTitle>
			<ul
				className="divide-y divide-(--sc-divider) rounded-(--sc-radius-lg) border border-(--sc-border-subtle)"
				data-model-usage
			>
				{rows.map(row => {
					const role = row.member
						? isPresetRole(row.member.role)
							? t(`modelPool.role.${row.member.role}`)
							: row.member.role
						: undefined;
					const detail = [
						row.main ? t("modelPool.usageMain") : t("modelPool.usageAgents", { count: row.agents }),
						role ? t("modelPool.usageRole", { role }) : undefined,
						t("modelPool.usageRequests", { count: row.requests }),
					]
						.filter(Boolean)
						.join(" · ");
					return (
						<li className="flex flex-col gap-1.5 px-4 py-2.5" key={`${row.main ? "main" : "sub"}:${row.model}`}>
							<div className="flex min-w-0 items-baseline gap-3 text-sc-sm">
								<span className="min-w-0 flex-1 truncate text-(--sc-text)" title={row.model}>
									{row.member?.name ?? row.model}
								</span>
								<span className="shrink-0 tabular-nums text-(--sc-text)">{formatTokens(row.tokens)}</span>
								<span className="w-16 shrink-0 text-right tabular-nums text-(--sc-text-muted)">
									{formatUsd(row.cost)}
								</span>
							</div>
							<span className="truncate text-sc-xs text-(--sc-text-muted)">{detail}</span>
							<ProgressBar color="var(--sc-info)" value={row.share} />
						</li>
					);
				})}
			</ul>
		</section>
	);
}
