/**
 * Advisor spend in the Run popover: ONE line, the lightbulb, "Advisor", a muted "$0.45 · 3 advisories" summary and an
 * (i) holding the numbers. Read from the gui-bridge (`get_advisor_stats`, stock's own `getAdvisorStats()`) when the
 * session is ready, when it changes and on each popover open; an omp or host that cannot report it, or an advisor
 * that is off and never spent anything, leaves the line out. `useAdvisorUsage` is also Insights' source.
 */

import { Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ADVISOR_SEVERITIES, type AdvisorUsage } from "../../../../../resources/gui-bridge/advisor-stats-contracts";
import { formatUsd } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabRpc } from "../../../lib/tab-rpc";
import { useSessionStore } from "../../../stores/session";
import { advisorSeverityLabel } from "../../chat/CustomMessageCard";
import { SettingInfo } from "../../common";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const count = z.number().finite().nonnegative().catch(0);

const usageSchema = z.object({
	configured: z.boolean().catch(false),
	active: z.boolean().catch(false),
	subscription: z.boolean().catch(false),
	cost: count,
	calls: count,
	tokens: z
		.object({ input: count, output: count, cacheRead: count, total: count })
		.catch({ input: 0, output: 0, cacheRead: 0, total: 0 }),
	advisories: z
		.object({ total: count, other: count, blocker: count, concern: count, nit: count })
		.catch({ total: 0, other: 0, blocker: 0, concern: 0, nit: 0 }),
	advisors: z
		.array(
			z.object({
				name: z.string().catch(""),
				status: z.string().catch(""),
				model: z.string().optional().catch(undefined),
				calls: count,
				cost: count,
			}),
		)
		.catch([]),
});

/** A reply's `data` as `AdvisorUsage`, or `null` when it is not an object at all. */
function parseAdvisorUsage(data: unknown): AdvisorUsage | null {
	const parsed = usageSchema.safeParse(data);
	return parsed.success ? parsed.data : null;
}

/** An advisor that is off and never spent or advised has nothing to show. */
export function hasAdvisorActivity(usage: AdvisorUsage): boolean {
	return usage.configured || usage.cost > 0 || usage.advisories.total > 0;
}

/** "Concern 2 · Nit 1": the non-zero severities, loudest first, then notes that came without one. */
export function advisorSeverityBreakdown(advisories: AdvisorUsage["advisories"], t: Translate): string {
	const parts = ADVISOR_SEVERITIES.filter(severity => advisories[severity] > 0).map(
		severity => `${advisorSeverityLabel(severity, t)} ${advisories[severity]}`,
	);
	if (advisories.other > 0) parts.push(`${t("input.advisor.severityOther")} ${advisories.other}`);
	return parts.join(" · ");
}

function advisorCountLabel(total: number, t: Translate): string {
	return t(total === 1 ? "input.advisor.countOne" : "input.advisor.countMany", { count: total });
}

/**
 * Re-reads on every ready session, session change, popover `open` and `refreshKey` change (Insights passes its own
 * refresh trigger). `null` while unknown, on a failed or thrown call and on a reply that is not an object.
 */
export function useAdvisorUsage(open: boolean, refreshKey: string | number = 0): AdvisorUsage | null {
	const rpc = useTabRpc();
	const sessionId = useSessionStore(state => state.sessionId);
	const ready = useSessionStore(state => state.status) === "ready";
	const [usage, setUsage] = useState<AdvisorUsage | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: sessionId, open and refreshKey are re-read triggers, not inputs.
	useEffect(() => {
		if (!ready) {
			setUsage(null);
			return;
		}
		let live = true;
		void Promise.resolve()
			.then(() => rpc.getAdvisorStats())
			.then(response => {
				if (live) setUsage(response.success ? parseAdvisorUsage(response.data) : null);
			})
			.catch(() => {
				if (live) setUsage(null);
			});
		return () => {
			live = false;
		};
	}, [rpc, ready, sessionId, open, refreshKey]);

	return usage;
}

function infoText(usage: AdvisorUsage, t: Translate): string {
	const cost = formatUsd(usage.cost);
	const models = [...new Set(usage.advisors.flatMap(advisor => (advisor.model ? [advisor.model] : [])))];
	return [
		usage.configured ? null : t("input.advisor.info.off"),
		t(usage.subscription ? "input.advisor.info.costSubscription" : "input.advisor.info.cost", { cost }),
		t("input.advisor.info.calls", { count: usage.calls }),
		usage.advisories.total === 0
			? t("input.advisor.info.noAdvisories")
			: t("input.advisor.info.advisories", {
					total: usage.advisories.total,
					breakdown: advisorSeverityBreakdown(usage.advisories, t),
				}),
		models.length > 0 ? t("input.advisor.info.models", { models: models.join(", ") }) : null,
	]
		.filter(Boolean)
		.join(" ");
}

export function AdvisorUsageRow({ usage }: { usage: AdvisorUsage | null }) {
	const t = useT();
	if (usage === null || !hasAdvisorActivity(usage)) return null;
	const label = t("input.advisor.title");
	const summary = [
		usage.configured ? null : t("input.advisor.off"),
		formatUsd(usage.cost),
		usage.advisories.total > 0 ? advisorCountLabel(usage.advisories.total, t) : null,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="flex min-h-(--sc-control-md) min-w-0 items-center gap-2 py-0.5" data-advisor-usage>
			<span
				aria-hidden
				className="flex size-(--sc-icon-md) shrink-0 items-center justify-center text-(--sc-text-muted)"
				data-setting-icon
			>
				<Lightbulb className="size-(--sc-icon-md)" />
			</span>
			<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text)">{label}</span>
			<span className="min-w-0 truncate text-sc-sm text-(--sc-text-muted) tabular-nums" data-advisor-summary>
				{summary}
			</span>
			<SettingInfo text={`${label}: ${infoText(usage, t)}`} />
		</div>
	);
}

/**
 * The Run popover's row, reading its own numbers when the popover renders it. `RunChip` loads this module lazily
 * (`lazyChunk`): the phone's first screen never shows it and has no room left in its JavaScript budget.
 */
export function RunAdvisorRow({ open }: { open: boolean }) {
	return <AdvisorUsageRow usage={useAdvisorUsage(open)} />;
}
