import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { cx, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import type { TodoSnapshot } from "../../stores/todo";
import { selectToolEntry, useToolsStore } from "../../stores/tools";
import { editArgumentPaths, workFilePathKey } from "../tools/edit-args";
import { getToolActivity, type ToolActivity } from "../tools/index";
import { LiveStepPeek } from "./LiveStepPeek";
import { LiveTurnMeter, OutputMeter } from "./TurnOutputMeter";
import { type GroupAgent, isInterruptedError, resolveWorkGroup } from "./WorkStatus";
import { isSkippedWork } from "./work-view";

interface ExecutionGroupProps {
	children: ReactNode;
	className?: string;
	expanded: boolean;
	failureCount?: number;
	live?: boolean;
	/** Output figures for finished work (provider usage of the group's messages). */
	output?: { tokens: number; rate: number };
	onExpandedChange: (expanded: boolean) => void;
	stepCount: number;
	toolCallIds: readonly string[];
	/** The group's reasoning is streaming right now (live step preview). */
	thinkingLive?: boolean;
	/** Timestamp of stock's empty aborted reply after this group. */
	stoppedAt?: number;
	todoSnapshots?: readonly TodoSnapshot[];
	notes?: readonly AgentMessage[];
}

/** Order of the human summary: reads, edits, commands, searches, then the rest. */
const ACTIVITY_ORDER: readonly ToolActivity[] = ["read", "edit", "run", "search", "other"];

/** English plural suffix per activity key ("1 file" / "2 files", "1 search" / "2 searches"). */
const PLURAL_SUFFIX: Record<ToolActivity, string> = { read: "s", edit: "s", run: "s", search: "es", other: "s" };

/**
 * One quiet disclosure for a reasoning/tool phase, summarized the way a person
 * would say it ("Read 2 files · Edited 1 file · Ran 1 command · 16s"). Its
 * open state is owned by ChatStream so streaming updates and live-to-final row
 * replacement cannot override the user's choice. While running and collapsed
 * it previews the current step underneath and carries the turn's live output
 * meter; finished, it shows the group's output total and average rate.
 */
export function ExecutionGroup({
	children,
	className,
	expanded,
	failureCount = 0,
	live = false,
	output,
	onExpandedChange,
	stepCount,
	toolCallIds,
	thinkingLive = false,
	stoppedAt,
	todoSnapshots,
	notes,
}: ExecutionGroupProps) {
	const t = useT();
	const cwd = useSessionStore(state => state.cwd);
	// Primitive selector: encode (running, failed, per-activity counts, span)
	// so unrelated tool events — partial results on cards outside this group —
	// never re-render the group.
	const encoded = useToolsStore(s => {
		let running = 0;
		let skipped = 0;
		let interrupted = 0;
		let start = Number.POSITIVE_INFINITY;
		let end = 0;
		let failed = 0;
		const counts: Record<ToolActivity, number> = { read: 0, edit: 0, run: 0, search: 0, other: 0 };
		// Files count once per group: writing a file and then editing it is one edited file, keyed
		// like the outcome's ledger so `./a.ts` and `/repo/a.ts` are the same file.
		const editedPaths = new Set<string>();
		for (const id of toolCallIds) {
			const entry = selectToolEntry(s, id);
			if (!entry) continue;
			if (entry.status === "aborted") {
				// Stock's internal interrupt_skipped waits are not steps; a user-interrupted call is.
				if (isSkippedWork(entry)) skipped++;
				else interrupted++;
				continue;
			}
			if (entry.status === "pending" || entry.status === "running") running++;
			else if (isInterruptedError(entry, stoppedAt)) interrupted++;
			else if (entry.status === "error" || entry.isError) failed++;
			const { activity } = getToolActivity(entry.toolName, entry.args);
			if (activity === "edit") {
				const paths = editArgumentPaths(entry.args);
				if (paths.length === 0) counts.edit++;
				for (const file of paths) editedPaths.add(workFilePathKey(file, cwd));
			} else counts[activity]++;
			start = Math.min(start, entry.startTime);
			end = Math.max(end, entry.endTime ?? 0);
		}
		counts.edit += editedPaths.size;
		const span = Number.isFinite(start) && end > start ? end - start : 0;
		return [running, failed, skipped, interrupted, span, ...ACTIVITY_ORDER.map(activity => counts[activity])].join(
			":",
		);
	});
	const [running = 0, toolFailures = 0, skipped = 0, interruptedTools = 0, spanMs = 0, ...activityCounts] = encoded
		.split(":")
		.map(Number);
	const resolveKey = useToolsStore(s => s.entryKeyForCallId);
	// Primitive key: each agent of this group with how its parent call ended.
	const agentKey = useSubagentsStore(s => {
		const tools = useToolsStore.getState();
		const rows: string[] = [];
		for (const node of s.subagents.values()) {
			if (!node.parentToolCallId) continue;
			const key = resolveKey(node.parentToolCallId);
			if (!toolCallIds.includes(key)) continue;
			const parent = selectToolEntry(tools, key);
			const parentState: GroupAgent["parent"] =
				!parent || parent.status === "pending" || parent.status === "running"
					? "running"
					: isInterruptedError(parent, stoppedAt)
						? "interrupted"
						: parent.status === "error" || parent.isError
							? "failed"
							: "done";
			rows.push(`${node.status}\u0000${parentState}`);
		}
		return rows.join("\u0001");
	});
	const agents: GroupAgent[] = agentKey
		? agentKey.split("\u0001").map(row => {
				const [status = "", parent = "done"] = row.split("\u0000");
				return { status, parent: parent as GroupAgent["parent"] };
			})
		: [];
	const { state, failed, interrupted, runningAgents } = resolveWorkGroup({
		live,
		runningTools: running,
		failedTools: toolFailures,
		reportedFailures: failureCount,
		interruptedTools,
		agents,
	});

	const activities = ACTIVITY_ORDER.flatMap((activity, index) => {
		const count = activityCounts[index] ?? 0;
		return count > 0
			? [t(`chat.process.kind.${activity}`, { count, plural: count === 1 ? "" : PLURAL_SUFFIX[activity] })]
			: [];
	});
	// `live` with nothing executing = the model is preparing the next step:
	// keep the spinner, but don't claim a tool is running.
	const totalSteps = Math.max(0, stepCount - skipped);
	const plural = totalSteps === 1 ? "" : "s";
	const summary =
		state === "failed"
			? t("chat.process.statusFailed", { failed, total: totalSteps, plural })
			: state === "running" && running > 0
				? t("chat.process.statusRunning", { running, total: totalSteps, plural })
				: state === "running" && runningAgents > 0
					? t("chat.process.statusAgents", { count: runningAgents, plural: runningAgents === 1 ? "" : "s" })
					: state === "interrupted"
						? t("chat.process.statusInterrupted", { interrupted, total: totalSteps, plural })
						: state === "complete" && activityCounts.slice(0, -1).every(count => count === 0)
							? t("chat.process.statusComplete", { total: totalSteps, plural })
							: activities.length > 0
								? activities.join(" · ")
								: state === "running"
									? t("chat.process.statusWorking", { total: totalSteps, plural })
									: t("chat.process.statusComplete", { total: totalSteps, plural });
	const duration = state !== "running" && spanMs > 0 ? formatDuration(spanMs) : null;
	// While the work card shows, this summary row lives in the card's head: the card's status mark
	// and narrative already say what is running, so the row keeps only the counts and the toggle.
	const shownSummary = state === "running" ? t("chat.work.stepCount", { total: totalSteps, plural }) : summary;
	const header = (
		<button
			aria-expanded={expanded}
			className={cx(
				"omp-execution-group-header flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-(--sc-radius-sm) px-1.5 text-left text-sc-sm transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover)",
				"omp-execution-group-header--embedded",
				state === "failed"
					? "text-(--sc-danger)"
					: "text-(--sc-text-muted) hover:text-(--sc-text) aria-expanded:text-(--sc-text-secondary)",
			)}
			onClick={() => onExpandedChange(!expanded)}
			type="button"
			aria-label={`${t("chat.process.title")}: ${summary}`}
		>
			<span
				aria-atomic="true"
				aria-live="polite"
				className="omp-execution-group-summary min-w-0 truncate"
				role="status"
			>
				{shownSummary}
			</span>
			{duration ? (
				<span className="omp-execution-group-duration -ms-1 shrink-0 tabular-nums text-(--sc-text-subtle)">
					· {duration}
				</span>
			) : null}
			{state === "running" ? (
				<LiveTurnMeter />
			) : output ? (
				<OutputMeter average estimated={false} rate={output.rate} tokens={output.tokens} />
			) : null}
			<ChevronRight
				aria-hidden="true"
				className={cx(
					"omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
					expanded && "rotate-90",
				)}
			/>
		</button>
	);

	return (
		<section className={cx("omp-execution-group", className)} data-state={state}>
			<LiveStepPeek
				summaryRow={header}
				thinkingLive={thinkingLive}
				toolCallIds={toolCallIds}
				state={state}
				stoppedAt={stoppedAt}
				stepsListed={expanded}
				carriesContext={live}
				todoSnapshots={todoSnapshots}
				notes={notes}
			/>
			{expanded ? <div className="omp-execution-group-body">{children}</div> : null}
		</section>
	);
}
