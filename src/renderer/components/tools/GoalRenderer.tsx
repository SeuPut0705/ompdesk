import { Target } from "lucide-react";
import { cx, formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { resultBodyText, resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

/**
 * Goal tool: objective, op, and token budget. Live results carry
 * GoalToolDetails ({ op, goal?, remainingTokens?, completionBudgetReport? })
 * where goal = { objective, status, tokenBudget?, tokensUsed, timeUsedSeconds };
 * hydrated history falls back to the content text.
 */

type GoalStatusTone = "accent" | "success" | "warning" | "muted";

const STATUS_TONE: Record<string, GoalStatusTone> = {
	active: "accent",
	complete: "success",
	"budget-limited": "warning",
	paused: "muted",
	dropped: "muted",
};

const STATUS_LABEL_KEY: Record<string, string> = {
	active: "modesPanel.goal.statusValue.active",
	complete: "modesPanel.goal.statusValue.complete",
	"budget-limited": "modesPanel.goal.statusValue.budgetLimited",
	paused: "modesPanel.goal.statusValue.paused",
	dropped: "modesPanel.goal.statusValue.dropped",
};

function describeOp(t: (key: string, params?: Record<string, string | number>) => string, op: unknown): string {
	switch (op) {
		case "create":
			return t("tools.goal.op.set");
		case "complete":
			return t("tools.goal.op.complete");
		case "get":
			return t("tools.goal.op.check");
		case "resume":
			return t("tools.goal.op.resume");
		case "drop":
			return t("tools.goal.op.drop");
		default:
			return typeof op === "string" ? op : "?";
	}
}

export function GoalRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const goal =
		details?.goal != null && typeof details.goal === "object" ? (details.goal as Record<string, unknown>) : null;
	const op = details?.op ?? args.op;
	const status = typeof goal?.status === "string" ? goal.status : "";
	const tone: GoalStatusTone = STATUS_TONE[status] ?? "accent";
	const objective =
		(typeof goal?.objective === "string" && goal.objective.trim()) ||
		(typeof args.objective === "string" && args.objective.trim()) ||
		"";
	const tokensUsed = typeof goal?.tokensUsed === "number" ? goal.tokensUsed : undefined;
	const tokenBudget =
		(typeof goal?.tokenBudget === "number" ? goal.tokenBudget : undefined) ??
		(typeof args.token_budget === "number" ? args.token_budget : undefined);
	const timeUsedSeconds = typeof goal?.timeUsedSeconds === "number" ? goal.timeUsedSeconds : 0;
	const report =
		typeof details?.completionBudgetReport === "string" && details.completionBudgetReport.trim()
			? details.completionBudgetReport
			: "";
	const fallback = resultBodyText(effective).trim();

	if (isError) {
		return (
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-1.5 text-omp-sm">
					<Target size={12} className="shrink-0 text-[var(--omp-error)]" />
					<span className="font-semibold text-[var(--omp-text)]">{t("tools.goal.title")}</span>
					<span className="text-[var(--omp-muted)]">{describeOp(t, op)}</span>
				</div>
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-tool-error-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-error)]">
					{fallback || t("tools.goal.failed")}
				</pre>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 text-omp-sm">
				<Target size={12} className="shrink-0" style={{ color: `var(--omp-${tone})` }} />
				<span className="font-semibold text-[var(--omp-text)]">{t("tools.goal.title")}</span>
				<span className="text-[var(--omp-muted)]">{describeOp(t, op)}</span>
				<span className="flex-1" />
				{status && (
					<span
						className={cx(
							"shrink-0 rounded px-1 py-px text-omp-xxs font-semibold",
							tone === "muted"
								? "bg-[var(--omp-bg-tertiary)] text-[var(--omp-muted)]" // surface-ok: tiny status pill
								: tone === "accent"
									? "bg-[var(--omp-accent)]/15 text-[var(--omp-accent)]"
									: tone === "success"
										? "bg-[var(--omp-success)]/15 text-[var(--omp-success)]"
										: "bg-[var(--omp-warning)]/15 text-[var(--omp-warning)]",
						)}
					>
						{STATUS_LABEL_KEY[status] ? t(STATUS_LABEL_KEY[status]) : status}
					</span>
				)}
				{!status && !goal && details != null && (
					<span className="shrink-0 text-omp-xs text-[var(--omp-dim)]">{t("tools.goal.noActive")}</span>
				)}
			</div>
			{objective && <div className="text-omp-sm italic leading-[1.45] text-[var(--omp-muted)]">“{objective}”</div>}
			{(tokensUsed != null || tokenBudget != null || timeUsedSeconds > 0) && (
				<div className="text-omp-xs tabular-nums text-[var(--omp-dim)]">
					{tokensUsed != null && tokenBudget != null
						? t("tools.goal.tokensOf", {
								used: formatTokens(tokensUsed),
								budget: formatTokens(tokenBudget),
								left: formatTokens(Math.max(0, tokenBudget - tokensUsed)),
							})
						: tokensUsed != null
							? t("tools.goal.tokensOnly", { count: formatTokens(tokensUsed) })
							: tokenBudget != null
								? t("tools.goal.budgetOnly", { count: formatTokens(tokenBudget) })
								: ""}
					{timeUsedSeconds > 0 &&
						t("tools.goal.elapsedSuffix", { duration: formatDuration(timeUsedSeconds * 1000) })}
				</div>
			)}
			{report && (
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-muted)]">
					{report}
				</pre>
			)}
			{!objective && !report && goal == null && fallback && (
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-tool-output)]">
					{fallback}
				</pre>
			)}
		</div>
	);
}
