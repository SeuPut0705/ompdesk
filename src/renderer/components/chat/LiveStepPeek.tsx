import { Brain } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { parseAnsi } from "../../lib/ansi";
import { resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { selectToolEntry, useToolsStore } from "../../stores/tools";
import { toolDiffStats } from "../tools/diff-stats";
import { getToolHeader } from "../tools/index";
import { DiffStatChip, ToolPathTarget } from "../tools/ToolCard";
import { appendLiveLog, type LiveLog, type LiveLogLine, selectLiveStep, tailLines } from "./live-step";

/** Lines the live log keeps; older ones scroll out of the window and are dropped. */
const LIVE_LOG_LINES = 50;
/** Characters of live reasoning read for the log (its tail is what's new). */
const THINKING_TAIL_CHARS = 600;
/** Reasoning lines shown per thinking step. */
const THINKING_TAIL_LINES = 6;
/** Distance from the bottom (px) that still counts as "at the newest line". */
const STICK_THRESHOLD_PX = 8;

/**
 * The running turn's log, by `<tab>:<turn start>`. The window can remount
 * mid-turn (the first step finalizing moves the live group from the streaming
 * row to the history row; virtualization recycles rows), and a remount must
 * pick the log up where it was instead of blanking and fading in again.
 */
const liveLogs = new Map<string, LiveLog>();

function rememberLog(key: string, log: LiveLog): void {
	const tab = key.slice(0, key.lastIndexOf(":") + 1);
	for (const other of liveLogs.keys()) if (other !== key && other.startsWith(tab)) liveLogs.delete(other);
	liveLogs.set(key, log);
}

/**
 * A small fixed-height window under a collapsed running work summary where
 * the turn's activity flows like a log: each step's label (kind icon, label,
 * target, +/− lines), a command's output lines and live reasoning append
 * below the previous ones. A short log reads top-down from the first row;
 * once it fills the window it follows the newest line and older lines scroll
 * up under a fade (shown only while something is scrolled out above). Its
 * height never changes while the turn runs, so the transcript around it does
 * not jump. It sticks to the newest line unless the user scrolls up inside
 * it. aria-hidden: the summary row's status carries the announcement, the
 * full steps are one disclosure away.
 */
export function LiveStepPeek({ thinkingLive, toolCallIds }: { thinkingLive: boolean; toolCallIds: readonly string[] }) {
	// Primitive selector: the log re-renders when the chosen step changes, not
	// on every unrelated tool event.
	const stepKey = useToolsStore(s => {
		const step = selectLiveStep(toolCallIds, { get: id => selectToolEntry(s, id) }, thinkingLive);
		return step === null ? "" : step.kind === "thinking" ? "thinking" : `tool:${step.id}`;
	});
	const toolCallId = stepKey.startsWith("tool:") ? stepKey.slice("tool:".length) : "";
	const toolLines = useToolLines(toolCallId);
	const thinkingLines = useThinkingLines(stepKey === "thinking");

	const tabId = useRuntimeTabId();
	const turnStart = useMessagesStore(s => s.turnMeter.startedAt);
	const logKey = `${tabId ?? ""}:${turnStart ?? ""}`;
	const [state, setState] = useState(() => ({ key: logKey, log: liveLogs.get(logKey) ?? [] }));
	// Resumed windows skip the entrance fade: they were already on screen.
	const [resumed] = useState(() => state.log.length > 0);
	const log = state.key === logKey ? state.log : [];
	// Record the current step during render; appendLiveLog returns the same
	// log when nothing changed, so this settles after one pass.
	if (stepKey) {
		// Reasoning restarts with each assistant message, after the group's
		// earlier calls, so the call count tells thinking episodes apart.
		const segmentKey = stepKey === "thinking" ? `thinking:${toolCallIds.length}` : stepKey;
		const next = appendLiveLog(
			log,
			{ key: segmentKey, lines: stepKey === "thinking" ? thinkingLines : toolLines },
			LIVE_LOG_LINES,
		);
		if (next !== log || state.key !== logKey) {
			rememberLog(logKey, next);
			setState({ key: logKey, log: next });
		}
	}

	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-pin whenever the log changes.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (element && stickRef.current) element.scrollTop = element.scrollHeight;
	}, [log]);

	return (
		<div aria-hidden className="omp-live-step" data-resumed={resumed || undefined}>
			<div
				className="omp-live-step-scroll"
				onScroll={event => {
					const element = event.currentTarget;
					stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD_PX;
					// Pinning moves scrollTop too, so this also tracks the fade over clipped lines.
					element.toggleAttribute("data-clipped", element.scrollTop > 0);
				}}
				ref={scrollRef}
			>
				<div className="omp-live-step-log">
					{log.flatMap(segment =>
						segment.lines.map((line, index) => <LogLine key={`${segment.key}:${index}`} line={line} />),
					)}
				</div>
			</div>
		</div>
	);
}

function LogLine({ line }: { line: LiveLogLine }) {
	if (line.kind === "tool") return <ToolLabel toolCallId={line.text} />;
	if (line.kind === "thinking") return <ThinkingLabel />;
	if (line.kind === "output") return <div className="omp-live-step-output">{line.text}</div>;
	return <div className="omp-live-step-text">{line.text}</div>;
}

function ThinkingLabel() {
	const t = useT();
	return (
		<div className="omp-live-step-line">
			<Brain aria-hidden className="omp-live-step-icon" />
			<span className="shrink-0 text-(--sc-text-secondary)">{t("chat.thinking.live")}</span>
		</div>
	);
}

/** Reasoning label plus the last lines of live reasoning. */
function useThinkingLines(active: boolean): readonly LiveLogLine[] {
	const tail = useMessagesStore(s => (active ? s.streamingThinking.slice(-THINKING_TAIL_CHARS) : ""));
	return useMemo(
		() => [
			{ kind: "thinking", text: "" },
			...tailLines(tail, THINKING_TAIL_LINES).map(text => ({ kind: "text" as const, text: text.trim() })),
		],
		[tail],
	);
}

/** The step label, plus a command's output lines (live while it runs, final once done). */
function useToolLines(toolCallId: string): readonly LiveLogLine[] {
	const entry = useToolsStore(s => (toolCallId ? selectToolEntry(s, toolCallId) : undefined));
	const command = entry ? getToolHeader(entry.toolName, entry.args).tool === "bash" : false;
	const partialResult = useToolsStore(s => (command ? s.partialResults.get(toolCallId) : undefined));
	const output = command ? (entry?.result ?? partialResult) : null;
	return useMemo(() => {
		if (!toolCallId) return [];
		const lines: LiveLogLine[] = [{ kind: "tool", text: toolCallId }];
		if (output == null) return lines;
		const plain = parseAnsi(resultText(output))
			.map(segment => segment.text)
			.join("");
		for (const text of tailLines(plain, LIVE_LOG_LINES)) lines.push({ kind: "output", text });
		return lines;
	}, [toolCallId, output]);
}

function ToolLabel({ toolCallId }: { toolCallId: string }) {
	const t = useT();
	const entry = useToolsStore(s => selectToolEntry(s, toolCallId));
	const toolName = entry?.toolName ?? "";
	const args = entry?.args ?? {};
	const failed = entry?.status === "error" || Boolean(entry?.isError);
	const header = getToolHeader(toolName, args);
	const Icon = header.icon;
	const result = entry?.result;
	const diffStats = useMemo(
		() => (entry?.status === "aborted" ? null : toolDiffStats(toolName, args, result, failed)),
		[toolName, args, result, failed, entry?.status],
	);
	if (!entry) return null;

	return (
		<div className="omp-live-step-line">
			<Icon aria-hidden className="omp-live-step-icon" />
			<span className="shrink-0 text-(--sc-text-secondary)">
				{header.labelKey ? t(header.labelKey) : header.tool}
			</span>
			{header.path ? (
				<ToolPathTarget moreFiles={header.moreFiles} path={header.path} />
			) : header.target ? (
				<span className="omp-tool-summary min-w-0 truncate font-mono text-(--sc-text-muted)" title={header.target}>
					{header.target}
				</span>
			) : null}
			{diffStats && (diffStats.added > 0 || diffStats.removed > 0) ? <DiffStatChip stats={diffStats} /> : null}
		</div>
	);
}
