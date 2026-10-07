import { Brain } from "lucide-react";
import { useMemo } from "react";
import { parseAnsi } from "../../lib/ansi";
import { resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useToolsStore } from "../../stores/tools";
import { toolDiffStats } from "../tools/diff-stats";
import { getToolHeader } from "../tools/index";
import { DiffStatChip, ToolPathTarget } from "../tools/ToolCard";
import { selectLiveStep, tailLines } from "./live-step";

/** Characters of live reasoning kept for the one-line snippet (its tail is what's new). */
const THINKING_SNIPPET_CHARS = 200;
/** Output lines a running command shows under its row. */
const COMMAND_TAIL_LINES = 2;

/**
 * What a collapsed running work group is doing right now, under its summary:
 * the current step's kind icon, label and target (file name first, command,
 * pattern, +/− lines), a running command's last output lines, or the tail of
 * live reasoning. Keyed per step, so a step change fades the new one in.
 */
export function LiveStepPeek({ thinkingLive, toolCallIds }: { thinkingLive: boolean; toolCallIds: readonly string[] }) {
	// Primitive selector: the peek re-renders when the chosen step changes, not
	// on every unrelated tool event.
	const stepKey = useToolsStore(s => {
		const step = selectLiveStep(toolCallIds, s.activeTools, thinkingLive);
		return step === null ? "" : step.kind === "thinking" ? "thinking" : `tool:${step.id}`;
	});
	if (!stepKey) return null;
	return (
		<div className="omp-live-step" key={stepKey}>
			{stepKey === "thinking" ? <ThinkingPeek /> : <ToolPeek toolCallId={stepKey.slice("tool:".length)} />}
		</div>
	);
}

function ThinkingPeek() {
	const t = useT();
	const snippet = useMessagesStore(s =>
		s.streamingThinking.slice(-THINKING_SNIPPET_CHARS).replace(/\s+/g, " ").trim(),
	);
	return (
		<div className="omp-live-step-line">
			<Brain aria-hidden className="omp-live-step-icon" />
			<span className="shrink-0 text-(--sc-text-secondary)">{t("chat.thinking.live")}</span>
			{snippet ? <span className="omp-live-step-snippet min-w-0 truncate">{snippet}</span> : null}
		</div>
	);
}

function ToolPeek({ toolCallId }: { toolCallId: string }) {
	const t = useT();
	const entry = useToolsStore(s => s.activeTools.get(toolCallId));
	const toolName = entry?.toolName ?? "";
	const args = entry?.args ?? {};
	const running = entry?.status === "running" || entry?.status === "pending";
	const failed = entry?.status === "error" || Boolean(entry?.isError);
	const header = getToolHeader(toolName, args);
	const Icon = header.icon;
	const result = entry?.result;
	const diffStats = useMemo(
		() => (entry?.status === "aborted" ? null : toolDiffStats(toolName, args, result, failed)),
		[toolName, args, result, failed, entry?.status],
	);
	const command = header.tool === "bash" && running;
	const partial = entry?.partialResult;
	const outputLines = useMemo(() => {
		if (!command || partial == null) return [];
		const plain = parseAnsi(resultText(partial))
			.map(segment => segment.text)
			.join("");
		return tailLines(plain, COMMAND_TAIL_LINES);
	}, [command, partial]);
	if (!entry) return null;

	return (
		<>
			<div className="omp-live-step-line">
				<Icon aria-hidden className="omp-live-step-icon" />
				<span className="shrink-0 text-(--sc-text-secondary)">
					{header.labelKey ? t(header.labelKey) : header.tool}
				</span>
				{header.path ? (
					<ToolPathTarget moreFiles={header.moreFiles} path={header.path} />
				) : header.target ? (
					<span
						className="omp-tool-summary min-w-0 truncate font-mono text-(--sc-text-muted)"
						title={header.target}
					>
						{header.target}
					</span>
				) : null}
				{diffStats && (diffStats.added > 0 || diffStats.removed > 0) ? <DiffStatChip stats={diffStats} /> : null}
			</div>
			{command ? (
				<div className="omp-live-step-output">
					{outputLines.map((line, index) => (
						<div className="truncate" key={`${index}:${line}`}>
							{line}
						</div>
					))}
				</div>
			) : null}
		</>
	);
}
