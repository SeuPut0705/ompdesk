import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { useFrameSelector } from "../../hooks/use-frame-selector";
import { cx, formatDuration, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { asRecord } from "../../lib/wire-value";
import { useSessionStore } from "../../stores/session";
import type { TodoSnapshot } from "../../stores/todo";
import { callIdOfEntryKey, selectToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { CopyButton } from "../common/CopyButton";
import { getToolActivity } from "../tools/index";
import { LiveStepPeek } from "./LiveStepPeek";
import { LiveTurnMeter, OutputMeter } from "./TurnOutputMeter";
import { revealStep, type StepReveal, StepRevealContext } from "./work/reveal-step";
import { useRunOutcome, useRunStores } from "./work/use-work-run";
import { type WorkFact, WorkMetrics } from "./work/WorkFacts";
import { type GroupAgent, isInterruptedError, resolveWorkGroup } from "./work/WorkStatus";
import {
	checkKind,
	commandOperation,
	commandProgram,
	firstErrorLine,
	settleFailures,
	summarizeChecks,
} from "./work/work-checks";
import { deriveFindings, operationLabel, stepOperations, workSummaryText } from "./work/work-findings";
import { finishedHeadline, parseTaskResults, runSpan, transcriptTodoSnapshot } from "./work/work-run";
import { messageSourceTimestamp } from "./work/work-turn";
import { isSkippedWork } from "./work/work-view";

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
	/** A step asked for from outside the transcript (the work board): shown like a finding's, once opened. */
	revealRequest?: StepReveal | null;
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
	revealRequest = null,
}: ExecutionGroupProps) {
	const t = useT();
	const openPreview = useUiStore(state => state.openPreview);
	const sectionRef = useRef<HTMLElement>(null);
	// The step a finding asked to show: the opened body looks for it once it is mounted.
	const [reveal, setReveal] = useState<StepReveal | null>(null);
	// A step asked for from outside (the work board, through ChatStream, which opened this card): show it too.
	useEffect(() => {
		if (revealRequest) setReveal({ key: revealRequest.key });
	}, [revealRequest]);
	useEffect(() => (reveal && expanded ? revealStep(sectionRef.current, reveal.key) : undefined), [reveal, expanded]);
	const setPanelTab = useUiStore(state => state.setPanelTab);
	const goal = useSessionStore(state => (live ? state.goal?.objective : undefined));
	const cwd = useSessionStore(state => state.cwd);
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
		// A live run still only thinking has no call yet: its clock starts with the reply streaming
		// now, the same stock message whose first call the clock reads from then on.
		const thinkingFrom =
			startedAt === undefined && live && state.streamingMessage
				? messageSourceTimestamp(state.streamingMessage)
				: undefined;
		return `${startedAt ?? thinkingFrom ?? ""}:${spanMs}`;
	});
	const [clockStart = "", clockSpan = "0"] = clockKey.split(":");
	const clock = { startedAt: clockStart ? Number(clockStart) : undefined, spanMs: Number(clockSpan) };
	const groupEntries = toolCallIds.flatMap(id => {
		const entry = selectToolEntry(tools.getState(), id);
		return entry ? [[id, entry] as const] : [];
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: `encoded` holds every status of the entries read here.
	const { checks, failedCommands, failedSteps, clearedFailures, recovered } = useMemo(() => {
		// Commands are keyed only on a card where one failed: most cards have none.
		const commands = outcome.commands.some(command => command.failed || (command.exitCode ?? 0) !== 0)
			? outcome.commands.map(commandOperation)
			: [];
		const steps = stepOperations(groupEntries, stoppedAt);
		const fromCommands = settleFailures(commands, cwd);
		const fromSteps = settleFailures(steps, cwd);
		// The head counts a failed call only while the verdict does: a fixed one, a probe, a read or a wait no longer.
		// A command the ledger has no row for stays counted.
		const standing = new Set([...fromCommands.unresolved, ...fromSteps.unresolved].map(call => call.toolCallId));
		const ledgered = new Set(outcome.commands.map(command => command.toolCallId));
		const clearedFailures = groupEntries.filter(
			([id, entry]) =>
				!standing.has(id) &&
				(entry.toolName !== "bash" || ledgered.has(id)) &&
				entry.status !== "aborted" &&
				(entry.status === "error" || entry.isError) &&
				!isInterruptedError(entry, stoppedAt),
		).length;
		const recovered = [
			...new Set(
				[...fromCommands.recovered, ...fromSteps.recovered].map(
					call => `${call.agentName ? `${call.agentName}: ` : ""}${operationLabel(call, cwd)}`,
				),
			),
		];
		return {
			checks: summarizeChecks(commands.length ? commands : outcome.commands, cwd, new Set(fromCommands.unresolved)),
			failedCommands: fromCommands.unresolved,
			failedSteps: fromSteps.unresolved,
			clearedFailures,
			recovered,
		};
	}, [outcome, encoded, toolCallIds.join("\u0000"), stoppedAt, cwd]);
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
		failedTools: toolFailures - clearedFailures,
		reportedFailures: failureCount,
		interruptedTools,
		agents: groupAgents,
		superseded,
		stopped: stoppedAt !== undefined,
	});
	const totalSteps = Math.max(0, stepCount - skipped);
	const plural = totalSteps === 1 ? "" : "s";
	// Every fact of a finished card, for the head button's accessible name and Copy summary. The head itself draws its
	// time and the step count (or, for a card that produced nothing, what it read and searched): the verdict blocks,
	// chips and agent lanes below carry every other fact.
	const facts: string[] = [];
	const say = (fact: string) => {
		facts.push(fact);
	};
	if (failed > 0) say(t("chat.work.commandsFailed", { count: failed }));
	if (state === "interrupted" && interrupted > 0) say(t("chat.work.interruptedCount", { count: interrupted }));
	const produced = facts.length;
	if (outcome.files.length) {
		const hasStats = outcome.files.some(file => file.added !== undefined);
		const added = outcome.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
		const removed = outcome.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
		const files = t("chat.work.filesChanged", {
			count: outcome.files.length,
		});
		say(hasStats ? `${files} +${added} −${removed}` : files);
	}
	// What the commands checked reads as its result ("tests passed", "build failed"); the
	// other commands keep their count.
	const checkLabels = checks.map(check => {
		const verdict = check.passed ? "passed" : "failed";
		const count = check.passed ? check.tests?.passed : check.tests?.failed;
		return {
			passed: check.passed,
			label:
				count !== undefined
					? t(`chat.work.check.${check.kind}.${verdict}Count`, { count })
					: t(`chat.work.check.${check.kind}.${verdict}`),
		};
	});
	for (const check of checkLabels) say(check.label);
	const otherCommands = outcome.commands.filter(
		command => command.interrupted || command.unknown || command.refused || !checkKind(command.command),
	).length;
	if (otherCommands) say(t("chat.work.commandsRun", { count: otherCommands }));
	if (agents.length) say(t("chat.work.agentsDone", { count: agents.length }));
	const readFacts: string[] = [];
	if (facts.length === produced) {
		if (reads) readFacts.push(t("chat.process.kind.read", { count: reads }));
		if (searches)
			readFacts.push(t("chat.process.kind.search", { count: searches, plural: searches === 1 ? "" : "es" }));
		for (const fact of readFacts) say(fact);
	}
	if (facts.length === produced) say(t("chat.work.stepCount", { total: totalSteps, plural }));
	const summary =
		state === "running" && running > 0
			? t("chat.process.statusRunning", { running, total: totalSteps, plural })
			: state === "running" && runningAgents > 0
				? t("chat.process.statusAgents", { count: runningAgents })
				: state === "running"
					? t("chat.process.statusWorking", { total: totalSteps, plural })
					: facts.join(" · ");
	const spanMs = clock.spanMs || toolSpanMs;
	const duration = state !== "running" && spanMs > 0 ? formatDuration(spanMs) : null;
	// A running card says its step count; a finished one that produced nothing (only reads and searches) says what it
	// read and searched instead, so its head is not an empty "7 steps".
	const shownParts =
		state !== "running" && readFacts.length ? readFacts : [t("chat.work.stepCount", { total: totalSteps, plural })];
	const commandFailures = failedCommands.filter(command => !checkKind(command.command));
	const { error, previewUrl } = deriveFindings({
		running: state === "running",
		checks,
		failures: commandFailures,
		commands: outcome.commands,
		failedStep: failedSteps[0]?.toolCallId,
	});
	const changed = state !== "running" && outcome.files.length > 0;
	// The run's todo as its own todo call recorded it, so a reload shows the same row as live.
	const todo = transcriptTodoSnapshot(groupEntries) ?? todoSnapshots?.at(-1);
	// A run that ended but whose own check or command failed never wears the green tick.
	const attention = state === "complete" && error !== undefined;
	const headline =
		finishedHeadline({ goal, todo }) ??
		(attention
			? t(checks.some(check => !check.passed) ? "chat.work.verdict.failed" : "chat.work.verdict.stepFailed")
			: undefined);
	const lanes = new Set(agents.map(agent => agent.id));
	const shownNotes = notes?.filter(note => !settlesLanesOnly(note, lanes));
	const header = (
		// controls-ok: the omp-execution-group-header class draws the whole control
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
			{/* One line of whole parts — the run's time first, where the live clock stood, then the
			    facts, then the meter. A card too narrow for them all drops whole parts from the end
			    (the button's label still reads every one) instead of cutting each one mid-word. */}
			<span className="omp-summary-line">
				{duration ? (
					<span className="omp-summary-part omp-execution-group-duration tabular-nums text-(--sc-text-subtle)">
						{duration}
					</span>
				) : null}
				{shownParts.length ? (
					<span aria-atomic="true" aria-live="polite" className="omp-execution-group-summary" role="status">
						{shownParts.map((part, index) => (
							<span className="omp-summary-part" key={part}>
								{index ? ` · ${part}` : part}
							</span>
						))}
					</span>
				) : null}
				{state === "running" ? (
					<LiveTurnMeter />
				) : output ? (
					<OutputMeter average estimated={false} rate={output.rate} tokens={output.tokens} />
				) : null}
			</span>
			<ChevronRight
				aria-hidden="true"
				className={cx(
					"omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
					expanded && "rotate-90",
				)}
			/>
		</button>
	);
	const show = (key?: string) => {
		onExpandedChange(true);
		if (key) setReveal({ key });
	};
	const copyButton = (
		<CopyButton
			className="omp-work-copy"
			label={t("chat.work.copySummary")}
			text={() =>
				workSummaryText({
					head: [headline, [duration, ...facts].filter(Boolean).join(" · ")].filter(Boolean).join("\n"),
					cause: error?.cause,
					files: outcome.files,
					checks: checkLabels,
					recovered,
					previewUrl,
					labels: {
						cause: t("chat.work.copy.cause"),
						changed: t("chat.work.copy.changed", { count: outcome.files.length }),
						checks: t("chat.work.copy.checks"),
						recovered: t("chat.work.copy.recovered"),
						preview: t("chat.work.chip.preview"),
						deleted: t("chat.work.copy.deleted"),
					},
				})
			}
		/>
	);
	// What the run did, finished cards only so a running card never reflows: what failed (each a verdict block with
	// its cause and exit code), then what changed, what passed and the dev server, each one button.
	const metrics: WorkFact[] = [];
	if (state !== "running") {
		const exitMeta = (code: number | null | undefined) =>
			code !== null && code !== undefined && code !== 0 ? t("chat.work.exit", { code }) : undefined;
		const checkFact = (check: (typeof checks)[number], index: number): WorkFact => {
			const sentence = checkLabels[index]?.label ?? "";
			const count = check.passed ? check.tests?.passed : check.tests?.failed;
			const exit = check.passed ? undefined : exitMeta(check.exitCode);
			return {
				key: `check-${check.kind}-${index}`,
				finding: check.passed ? (check.kind === "test" ? "tests" : `check-${check.kind}`) : "error",
				tone: check.passed ? "ok" : "fail",
				icon: check.passed ? "check" : "error",
				// A failed check reads as its verdict ("2 tests failed"); a passing one stays short ("Tests 128").
				label: check.passed
					? t(check.kind === "test" ? "chat.work.chip.tests" : `chat.work.metric.${check.kind}`)
					: sentence,
				...(count !== undefined && check.passed ? { figure: count } : {}),
				...(!check.passed && check.cause ? { detail: check.cause } : {}),
				...(exit ? { meta: exit } : {}),
				sentence,
				title: !check.passed
					? t("chat.work.cause.open")
					: check.kind === "test"
						? t("chat.work.chip.testsOpen")
						: sentence,
				onSelect: () => show(check.toolCallId),
			};
		};
		const checkFacts = checks.map((check, index) => checkFact(check, index));
		// A failed command that is no check reads as a verdict too; the last one is the one shown (the run's latest word).
		const commandFacts = commandFailures.map((command, index): WorkFact => {
			const program = commandProgram(command.command) ?? command.command.trim().split(/\s+/)[0] ?? "";
			const label = t("chat.work.metric.commandFailed", {
				command: program.length > 24 ? `${program.slice(0, 23)}…` : program,
			});
			const cause = firstErrorLine(command.text ?? "");
			const exit = exitMeta(command.exitCode);
			return {
				key: `command-${index}`,
				finding: "error",
				tone: "fail",
				icon: "error",
				label,
				...(cause ? { detail: cause } : {}),
				...(exit ? { meta: exit } : {}),
				sentence: `${label}: ${command.command}`,
				title: t("chat.work.cause.open"),
				// A subagent's command has no call of ours to reveal: the click just opens the steps.
				onSelect: () => show(command.toolCallId),
			};
		});
		// One verdict block, never a stack: the failing check first, else the last failed command; the rest fold into
		// one quiet line of it that opens the steps.
		const failures = [...checkFacts.filter((_, index) => !checks[index]?.passed), ...commandFacts.toReversed()];
		const [primary] = failures;
		if (primary) {
			const others = failures.length - 1;
			metrics.push(
				others > 0
					? {
							...primary,
							more: { label: t("chat.work.verdict.more", { count: others }), onSelect: () => show() },
						}
					: primary,
			);
		} else if (error) {
			metrics.push({
				key: "error",
				finding: "error",
				tone: "fail",
				icon: "error",
				label: t("chat.work.chip.error"),
				...(error.cause ? { detail: error.cause } : {}),
				sentence: `${t("chat.work.chip.error")}${error.cause ? `: ${error.cause}` : ""}`,
				title: t("chat.work.cause.open"),
				onSelect: () => show(error.toolCallId),
			});
		}
		const stopped = outcome.commands.filter(command => command.interrupted);
		if (stopped.length) {
			metrics.push({
				key: "stopped",
				finding: "stopped",
				tone: "neutral",
				icon: "stopped",
				label: t("chat.work.interruptedCount", { count: stopped.length }),
				sentence: t("chat.work.interruptedCount", { count: stopped.length }),
				title: t("chat.work.metric.stopped"),
				onSelect: () => show(stopped[0]?.toolCallId),
			});
		}
		const unknown = outcome.commands.filter(command => command.unknown && !command.interrupted);
		if (unknown.length) {
			metrics.push({
				key: "unknown",
				finding: "unknown",
				tone: "neutral",
				icon: "stopped",
				label: t("chat.work.unknown"),
				sentence: t("chat.work.unknown"),
				title: t("chat.work.unknown"),
				onSelect: () => show(unknown[0]?.toolCallId),
			});
		}
		if (changed) {
			const stats = outcome.files.some(file => file.added !== undefined);
			const added = outcome.files.reduce((sum, file) => sum + (file.added ?? 0), 0);
			const removed = outcome.files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
			metrics.push({
				key: "files",
				finding: "changes",
				tone: "neutral",
				icon: "files",
				label: t("chat.work.metric.files"),
				figure: (
					<>
						{outcome.files.length}
						{stats ? (
							<span className="omp-work-diff">
								<span data-diff="added">+{added}</span> <span data-diff="removed">−{removed}</span>
							</span>
						) : null}
					</>
				),
				sentence: t("chat.work.filesChanged", { count: outcome.files.length }),
				title: t("chat.work.openChanges"),
				onSelect: () => setPanelTab("diff"),
			});
		}
		metrics.push(...checkFacts.filter((_, index) => checks[index]?.passed));
		if (previewUrl) {
			metrics.push({
				key: "preview",
				finding: "preview",
				tone: "neutral",
				icon: "preview",
				label: t("chat.work.chip.preview"),
				sentence: t("chat.work.chip.previewOpen", { url: previewUrl }),
				title: t("chat.work.chip.previewOpen", { url: previewUrl }),
				onSelect: () => openPreview(previewUrl),
			});
		}
	}
	const hasFindings = metrics.length > 0;
	const findings = hasFindings ? <WorkMetrics facts={metrics} /> : null;

	return (
		<section
			className={cx("omp-execution-group", className)}
			data-state={state}
			data-verdict={attention ? "failed" : undefined}
			ref={sectionRef}
		>
			<LiveStepPeek
				attention={attention}
				summaryRow={
					hasFindings ? (
						<>
							{copyButton}
							{header}
						</>
					) : (
						header
					)
				}
				findings={findings}
				thinkingLive={thinkingLive}
				toolCallIds={toolCallIds}
				state={state}
				stoppedAt={stoppedAt}
				liveTail={live}
				todoSnapshots={todo ? [todo] : undefined}
				notes={shownNotes}
				headline={headline}
				runStartedAt={clock.startedAt}
			/>
			{expanded ? (
				<StepRevealContext.Provider value={reveal}>
					<div className="omp-execution-group-body">{children}</div>
				</StepRevealContext.Provider>
			) : null}
		</section>
	);
}
