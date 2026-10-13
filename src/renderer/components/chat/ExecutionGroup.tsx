import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { cx, formatDuration, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { asRecord } from "../../lib/wire-value";
import { useSessionStore } from "../../stores/session";
import type { TodoSnapshot } from "../../stores/todo";
import { callIdOfEntryKey, selectToolEntry, useToolsStore } from "../../stores/tools";
import { getToolActivity } from "../tools/index";
import { LiveStepPeek } from "./LiveStepPeek";
import { LiveTurnMeter, OutputMeter } from "./TurnOutputMeter";
import { useRunOutcome, useRunStores } from "./use-work-run";
import { type GroupAgent, isInterruptedError, resolveWorkGroup } from "./WorkStatus";
import { finishedHeadline, parseTaskResults, runSpan, transcriptTodoSnapshot } from "./work-run";
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
	/** A later work card exists in this session; this one never shows a running head. */
	superseded?: boolean;
}

/** A completion notice only for agents that have a lane: the lane already states it. */
function settlesLanesOnly(message: AgentMessage, lanes: ReadonlySet<string>): boolean {
	if (message.role !== "custom" || message.customType !== "async-result") return false;
	const jobs = asRecord(message.details)?.jobs;
	const ids = Array.isArray(jobs)
		? jobs.map(job => {
				const record = asRecord(job);
				return record?.type === undefined || record.type === "task"
					? [record?.agentId, record?.jobId].find(id => typeof id === "string" && lanes.has(id))
					: undefined;
			})
		: parseTaskResults(resultText(message.content)).map(result => (lanes.has(result.id) ? result.id : undefined));
	return ids.length > 0 && ids.every(id => id !== undefined);
}

/**
 * One work card for a reasoning/tool run. Its head carries the run's single
 * summary: how it ended, then what the whole run (main agent and subagents)
 * produced — the same ledger the outcome lists — and its span from stock's own
 * timestamps, so a reloaded session reads exactly as it did live. Its open
 * state is owned by ChatStream so streaming updates and live-to-final row
 * replacement cannot override the user's choice.
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
	superseded = false,
}: ExecutionGroupProps) {
	const t = useT();
	const goal = useSessionStore(state => (live ? state.goal?.objective : undefined));
	const { tools, messages } = useRunStores();
	// Primitive selector: encode (running, failed, skipped, interrupted, span, reads, searches)
	// so unrelated tool events — partial results on cards outside this group — never re-render it.
	const encoded = useToolsStore(s => {
		let running = 0;
		let skipped = 0;
		let interrupted = 0;
		let failed = 0;
		let reads = 0;
		let searches = 0;
		let start = Number.POSITIVE_INFINITY;
		let end = 0;
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
			if (activity === "read") reads++;
			else if (activity === "search") searches++;
			start = Math.min(start, entry.startTime);
			end = Math.max(end, entry.endTime ?? 0);
		}
		const span = Number.isFinite(start) && end > start ? end - start : 0;
		return [running, failed, skipped, interrupted, span, reads, searches].join(":");
	});
	const [running = 0, toolFailures = 0, skipped = 0, interruptedTools = 0, toolSpanMs = 0, reads = 0, searches = 0] =
		encoded.split(":").map(Number);
	const { outcome, agents } = useRunOutcome(toolCallIds, stoppedAt);
	// The run's clock as a primitive: a history page prepended or a message committed
	// elsewhere re-renders only the cards whose own clock it moved.
	const clockKey = useFrameSelector(messages, state => {
		const entries = tools.getState();
		const callIds = toolCallIds.flatMap(key => {
			const id = callIdOfEntryKey(key);
			return toolCallIds.includes(entries.entryKeyForCallId(id)) ? [id] : [];
		});
		const { startedAt, spanMs } = runSpan([state.messages, state.liveMessages], callIds);
		return `${startedAt ?? ""}:${spanMs}`;
	});
	const [clockStart = "", clockSpan = "0"] = clockKey.split(":");
	const clock = { startedAt: clockStart ? Number(clockStart) : undefined, spanMs: Number(clockSpan) };
	const groupAgents: GroupAgent[] = agents.map(node => {
		const parent = node.parentToolCallId
			? selectToolEntry(tools.getState(), tools.getState().entryKeyForCallId(node.parentToolCallId))
			: undefined;
		return {
			status: node.status,
			parent:
				!parent || parent.status === "pending" || parent.status === "running"
					? "running"
					: isInterruptedError(parent, stoppedAt)
						? "interrupted"
						: parent.status === "error" || parent.isError
							? "failed"
							: "done",
		};
	});
	const { state, failed, interrupted, runningAgents } = resolveWorkGroup({
		live,
		runningTools: running,
		failedTools: toolFailures,
		reportedFailures: failureCount,
		interruptedTools,
		agents: groupAgents,
		superseded,
	});
	const totalSteps = Math.max(0, stepCount - skipped);
	const plural = totalSteps === 1 ? "" : "s";
	const countPlural = (count: number) => (count === 1 ? "" : "s");
	// One fact line for every finished card: failures once, then what the whole run produced.
	const facts: string[] = [];
	if (failed > 0) facts.push(t("chat.work.commandsFailed", { count: failed }));
	if (state === "interrupted" && interrupted > 0) facts.push(t("chat.work.interruptedCount", { count: interrupted }));
	const produced = facts.length;
	if (outcome.files.length) {
		const hasStats = outcome.files.some(file => file.added !== undefined);
		const added = outcome.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
		const removed = outcome.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
		const files = t("chat.work.filesChanged", {
			count: outcome.files.length,
			plural: countPlural(outcome.files.length),
		});
		facts.push(hasStats ? `${files} +${added} −${removed}` : files);
	}
	if (outcome.commands.length)
		facts.push(
			t("chat.work.commandsRun", { count: outcome.commands.length, plural: countPlural(outcome.commands.length) }),
		);
	if (agents.length)
		facts.push(t("chat.work.agentsDone", { count: agents.length, plural: countPlural(agents.length) }));
	if (facts.length === produced) {
		if (reads) facts.push(t("chat.process.kind.read", { count: reads, plural: countPlural(reads) }));
		if (searches) facts.push(t("chat.process.kind.search", { count: searches, plural: searches === 1 ? "" : "es" }));
	}
	if (facts.length === produced) facts.push(t("chat.work.stepCount", { total: totalSteps, plural }));
	const summary =
		state === "running" && running > 0
			? t("chat.process.statusRunning", { running, total: totalSteps, plural })
			: state === "running" && runningAgents > 0
				? t("chat.process.statusAgents", { count: runningAgents, plural: countPlural(runningAgents) })
				: state === "running"
					? t("chat.process.statusWorking", { total: totalSteps, plural })
					: facts.join(" · ");
	const spanMs = clock.spanMs || toolSpanMs;
	const duration = state !== "running" && spanMs > 0 ? formatDuration(spanMs) : null;
	// While running, the card's status mark and narrative already say what is running:
	// the row keeps only the step count and the toggle.
	const shownSummary = state === "running" ? t("chat.work.stepCount", { total: totalSteps, plural }) : summary;
	const groupEntries = toolCallIds.flatMap(id => {
		const entry = selectToolEntry(tools.getState(), id);
		return entry ? [[id, entry] as const] : [];
	});
	// The run's todo as its own todo call recorded it, so a reload shows the same row as live.
	const todo = transcriptTodoSnapshot(groupEntries) ?? todoSnapshots?.at(-1);
	const headline = finishedHeadline({ goal, todo, agents });
	const lanes = new Set(agents.map(agent => agent.id));
	const shownNotes = notes?.filter(note => !settlesLanesOnly(note, lanes));
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
			aria-label={`${t("chat.process.title")}: ${summary}${duration ? ` · ${duration}` : ""}`}
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
				todoSnapshots={todo ? [todo] : undefined}
				notes={shownNotes}
				headline={headline}
				runStartedAt={clock.startedAt}
			/>
			{expanded ? <div className="omp-execution-group-body">{children}</div> : null}
		</section>
	);
}
