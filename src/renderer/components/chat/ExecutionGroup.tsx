import { ChevronRight, CircleCheck, CircleX } from "lucide-react";
import type { ReactNode } from "react";
import { cx, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useToolsStore } from "../../stores/tools";
import { Spinner } from "../common";
import { getToolActivity, type ToolActivity } from "../tools/index";

interface ExecutionGroupProps {
	children: ReactNode;
	className?: string;
	expanded: boolean;
	failureCount?: number;
	live?: boolean;
	onExpandedChange: (expanded: boolean) => void;
	stepCount: number;
	toolCallIds: readonly string[];
}

/** Order of the human summary: reads, edits, commands, searches, then the rest. */
const ACTIVITY_ORDER: readonly ToolActivity[] = ["read", "edit", "run", "search", "other"];

/** English plural suffix per activity key ("1 file" / "2 files", "1 search" / "2 searches"). */
const PLURAL_SUFFIX: Record<ToolActivity, string> = { read: "s", edit: "s", run: "s", search: "es", other: "s" };

/**
 * One quiet disclosure for a reasoning/tool phase, summarized the way a person
 * would say it ("Read 2 files · Edited 1 file · Ran 1 command · 16s"). Its
 * open state is owned by ChatStream so streaming updates and live-to-final row
 * replacement cannot override the user's choice.
 */
export function ExecutionGroup({
	children,
	className,
	expanded,
	failureCount = 0,
	live = false,
	onExpandedChange,
	stepCount,
	toolCallIds,
}: ExecutionGroupProps) {
	const t = useT();
	// Primitive selector: encode (running, failed, per-activity counts, span)
	// so unrelated tool events — partial results on cards outside this group —
	// never re-render the group.
	const encoded = useToolsStore(s => {
		let running = 0;
		let failed = 0;
		let start = Number.POSITIVE_INFINITY;
		let end = 0;
		const counts: Record<ToolActivity, number> = { read: 0, edit: 0, run: 0, search: 0, other: 0 };
		for (const id of toolCallIds) {
			const entry = s.activeTools.get(id);
			if (!entry) continue;
			if (entry.status === "pending" || entry.status === "running") running++;
			else if (entry.status === "error" || entry.isError) failed++;
			const { activity, files } = getToolActivity(entry.toolName, entry.args);
			counts[activity] += activity === "edit" ? files : 1;
			start = Math.min(start, entry.startTime);
			end = Math.max(end, entry.endTime ?? 0);
		}
		const span = Number.isFinite(start) && end > start ? end - start : 0;
		return [running, failed, span, ...ACTIVITY_ORDER.map(activity => counts[activity])].join(":");
	});
	const [running = 0, toolFailures = 0, spanMs = 0, ...activityCounts] = encoded.split(":").map(Number);
	const failed = toolFailures + failureCount;

	const active = live || running > 0;
	const state = active ? "running" : failed > 0 ? "failed" : "complete";

	const activities = ACTIVITY_ORDER.flatMap((activity, index) => {
		const count = activityCounts[index] ?? 0;
		return count > 0
			? [t(`chat.process.kind.${activity}`, { count, plural: count === 1 ? "" : PLURAL_SUFFIX[activity] })]
			: [];
	});
	const summary =
		state === "failed"
			? t("chat.process.statusFailed", { failed, total: stepCount })
			: state === "running"
				? t("chat.process.statusRunning", { running: Math.max(1, running), total: stepCount })
				: activities.length > 0
					? activities.join(" · ")
					: t("chat.process.statusComplete", { total: stepCount });
	const duration = state !== "running" && spanMs > 0 ? formatDuration(spanMs) : null;

	return (
		<section className={cx("omp-execution-group", className)} data-state={state}>
			<button
				aria-expanded={expanded}
				className={cx(
					"omp-execution-group-header flex min-h-7 w-full min-w-0 items-center gap-2 rounded-(--sc-radius-sm) px-1.5 text-left text-sc-sm transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover)",
					state === "failed" ? "text-(--sc-danger)" : "text-(--sc-text-muted) hover:text-(--sc-text)",
				)}
				onClick={() => onExpandedChange(!expanded)}
				type="button"
				aria-label={`${t("chat.process.title")}: ${summary}`}
			>
				<span
					aria-hidden
					className="flex size-(--sc-icon-sm) shrink-0 items-center justify-center [&>svg]:size-(--sc-icon-sm)"
				>
					{state === "running" ? <Spinner size="sm" /> : state === "failed" ? <CircleX /> : <CircleCheck />}
				</span>
				<span
					aria-atomic="true"
					aria-live="polite"
					className="omp-execution-group-summary min-w-0 truncate font-medium"
					role="status"
				>
					{summary}
				</span>
				{duration ? (
					<span className="omp-execution-group-duration shrink-0 tabular-nums text-(--sc-text-subtle)">
						· {duration}
					</span>
				) : null}
				<ChevronRight
					aria-hidden="true"
					className={cx(
						"omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
						expanded && "rotate-90",
					)}
				/>
			</button>
			{expanded && <div className="omp-execution-group-body">{children}</div>}
		</section>
	);
}
