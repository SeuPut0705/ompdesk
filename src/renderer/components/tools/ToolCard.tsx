import { Ban, ChevronRight, CircleX } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { basename, cx, dirname, durationBetween, resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { selectDesktopSlotPosition, useDesktopSlotStore } from "../../stores/desktop-slot";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { selectToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { Spinner } from "../common";
import { type DiffStats, toolDiffStats } from "./diff-stats";
import { getToolHeader, getToolRenderer } from "./index";
import { ToolResultMedia } from "./media/ToolMedia";
import { DiagnosticsChip, type FileDiagnostics, resultDiagnostics } from "./renderers/Diagnostics";
import { GenericRenderer } from "./renderers/GenericRenderer";

export interface ToolRendererProps {
	args: Record<string, unknown>;
	result: unknown;
	isError?: boolean;
	isPartial?: boolean;
	partialResult?: unknown;
	/** Compact in-chat work surface; reuse the same parser and show its content immediately. */
	livePreview?: boolean;
	toolCallId?: string;
	/**
	 * The call ended without ever reporting a result (interrupted turn, dead
	 * process). Renderers must stop showing live text — the run is over, but
	 * no `result` arrives to replace it.
	 */
	interrupted?: boolean;
}

export interface ToolCardProps {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	/** A parent activity indicator can own animation for a live tool group. */
	runningIndicator?: RunningIndicator;
}

/** File-changing tools whose results carry stock's LSP `diagnostics`. */
const DIAGNOSTIC_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true };

export type RunningIndicator = "spinner" | "dot";

/** Row chrome shared by every work step (tool rows, grouped reads) so they read as one list.
 * The hover wash hugs the row's content instead of spanning the whole column. */
export const TOOL_ROW_CLASS =
	"omp-tool-header flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-(--sc-radius-sm) px-1.5 text-left text-sc-sm transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover)";

/** The one status/kind icon slot of a step row: live, failed, stopped, or the kind icon when done. */
export function ToolStatusIcon({
	state,
	runningIndicator,
	kindIcon,
}: {
	state: "running" | "error" | "aborted" | "done";
	runningIndicator: RunningIndicator;
	kindIcon: ReactNode;
}) {
	return (
		<span
			aria-hidden
			className={cx(
				"omp-tool-status-icon flex size-(--sc-icon-sm) shrink-0 items-center justify-center [&>svg]:size-(--sc-icon-sm)",
				state === "error" ? "text-(--sc-danger)" : "text-(--sc-text-muted)",
			)}
		>
			{state === "running" ? (
				runningIndicator === "spinner" ? (
					<Spinner size="sm" spin />
				) : (
					<span className="size-1.5 rounded-full bg-(--sc-text-muted)" />
				)
			) : state === "error" ? (
				<CircleX />
			) : state === "aborted" ? (
				<Ban />
			) : (
				kindIcon
			)}
		</span>
	);
}

/** File target: the name first, its folder muted — both mono, the whole path in the tooltip. */
export function ToolPathTarget({ path, moreFiles, suffix }: { path: string; moreFiles?: number; suffix?: string }) {
	const folder = dirname(path);
	const more = moreFiles ? ` +${moreFiles}` : "";
	return (
		<span className="omp-tool-summary min-w-0 truncate font-mono" title={`${path}${suffix ?? ""}${more}`}>
			<span className="text-(--sc-text)">
				{basename(path)}
				{suffix}
			</span>
			{folder && folder !== "." ? <span className="ms-1.5 text-(--sc-text-subtle)">{folder}</span> : null}
			{more ? <span className="ms-1.5 text-(--sc-text-muted)">{more.trim()}</span> : null}
		</span>
	);
}

/** `+N −M` on a collapsed file-changing row; numbers carry the meaning, color only reinforces it. */
export function DiffStatChip({ stats }: { stats: DiffStats }) {
	const t = useT();
	return (
		<span className="omp-tool-diffstat flex shrink-0 items-center gap-1 font-mono text-sc-xs tabular-nums">
			<span aria-hidden className="text-(--sc-success)">
				+{stats.added}
			</span>
			<span aria-hidden className="text-(--sc-danger)">
				−{stats.removed}
			</span>
			<span className="sr-only">{t("tools.diffStat", { added: stats.added, removed: stats.removed })}</span>
		</span>
	);
}

/**
 * One work step: kind icon, human label, target (file name first, command,
 * pattern), diff stat, duration, expand/collapse. The body comes from the
 * tool registry; the tool_result arrives via the tools store keyed by
 * toolCallId.
 */
export function ToolCard({ toolCallId, toolName, args, runningIndicator = "spinner" }: ToolCardProps) {
	const t = useT();
	const entry = useToolsStore(s => selectToolEntry(s, toolCallId));
	const expandAll = useUiStore(s => s.toolsExpandAll);
	// A running `eval` of a session queued for the desktop slot is not running yet: it waits for its turn.
	const tabId = useRuntimeTabId();
	const slotPosition = useDesktopSlotStore(s =>
		toolName === "eval" && entry?.status === "running" ? selectDesktopSlotPosition(s, tabId) : null,
	);
	const [expanded, setExpanded] = useState(expandAll.expanded);
	// Only an open body shows streaming output, so a collapsed card ignores it.
	const partialResult = useToolsStore(s => (expanded ? s.partialResults.get(toolCallId) : undefined));

	// ⌃O expand/collapse-all: every card snaps to the latest shared target.
	useEffect(() => {
		setExpanded(expandAll.expanded);
	}, [expandAll]);

	const entryStatus = entry?.status ?? "running";
	// "pending" (args still streaming) is a live sub-state: spinner, not a check.
	const status = entryStatus === "pending" ? "running" : entryStatus;
	const isError = Boolean(entry?.isError);
	const failed = status === "error" || isError;
	const isPartial = status === "running";
	const isAborted = status === "aborted";
	const now = useNowTick(isPartial);
	const duration = entry ? durationBetween(entry.startTime, isPartial ? now : entry.endTime) : null;
	// While args stream in, `args` is still {} — surface the raw partial JSON
	// (truncated) so a long bash/edit call doesn't sit as an empty row until
	// message_end.
	const streamingSummary =
		entry?.status === "pending" && typeof entry.streamingArgs === "string"
			? entry.streamingArgs.slice(0, 160)
			: undefined;
	const Renderer = getToolRenderer(toolName);
	const header = getToolHeader(toolName, args);
	const KindIcon = header.icon;
	const result = entry?.result;
	const diffStats = useMemo(
		() => (isAborted ? null : toolDiffStats(toolName, args, result, failed)),
		[toolName, args, result, failed, isAborted],
	);
	// Stock's head chip for LSP diagnostics after a file change (`2 diagnostics`).
	const diagnostics = useMemo(
		(): FileDiagnostics[] =>
			DIAGNOSTIC_TOOLS[toolName] && !failed && result != null ? resultDiagnostics(resultDetails(result)) : [],
		[toolName, result, failed],
	);

	return (
		<div
			className="omp-tool-card min-w-0"
			data-tool-call-id={toolCallId}
			data-tool-status={status}
			data-tool-error={isError ? "true" : undefined}
		>
			<button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className={TOOL_ROW_CLASS}>
				<ToolStatusIcon
					kindIcon={<KindIcon />}
					runningIndicator={runningIndicator}
					state={failed ? "error" : isAborted ? "aborted" : status === "running" ? "running" : "done"}
				/>
				<span
					className={cx(
						"omp-tool-name shrink-0 font-medium",
						failed ? "text-(--sc-danger)" : "text-(--sc-text-secondary)",
					)}
				>
					{header.labelKey ? t(header.labelKey, header.labelParams) : header.tool}
				</span>
				{status === "running" && !failed ? <span className="sr-only">{t("chat.exec.running")}</span> : null}
				{slotPosition !== null && !failed ? (
					<span
						className="omp-tool-summary min-w-0 truncate text-(--sc-text-muted)"
						data-desktop-slot-waiting={slotPosition}
					>
						{t("desktopSlot.waiting", { position: slotPosition })}
					</span>
				) : null}
				{header.path ? (
					<ToolPathTarget moreFiles={header.moreFiles} path={header.path} />
				) : header.target ? (
					<span
						className="omp-tool-summary min-w-0 truncate font-mono text-(--sc-text-muted)"
						title={header.target}
					>
						{header.target}
					</span>
				) : streamingSummary ? (
					<span className="omp-tool-summary min-w-0 truncate font-mono text-(--sc-text-subtle)">
						{streamingSummary}…
					</span>
				) : null}
				{diffStats && (diffStats.added > 0 || diffStats.removed > 0) ? <DiffStatChip stats={diffStats} /> : null}
				<DiagnosticsChip files={diagnostics} />
				{failed ? (
					<span className="omp-tool-state shrink-0 text-sc-xs font-medium text-(--sc-danger)">
						{t("tools.status.failed")}
					</span>
				) : isAborted ? (
					<span className="omp-tool-state shrink-0 text-sc-xs text-(--sc-text-muted)">
						{t("tools.status.interrupted")}
					</span>
				) : null}
				{duration && (
					<span className="omp-tool-duration shrink-0 text-sc-xs tabular-nums text-(--sc-text-subtle)">
						{duration}
					</span>
				)}
				<ChevronRight
					aria-hidden
					className={cx(
						"omp-tool-chevron omp-disclosure-chevron size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)",
						expanded && "rotate-90",
					)}
				/>
			</button>
			{expanded && (
				<div className="omp-tool-body">
					{/* A specialized renderer would claim "no matches" for a call that never
					 * returned, so an output-less abort shows only what was asked for. */}
					{isAborted && entry?.result == null && partialResult == null ? (
						<GenericRenderer args={args} result={null} interrupted />
					) : (
						<>
							<Renderer
								args={args}
								result={entry?.result}
								isError={isError}
								isPartial={isPartial}
								partialResult={partialResult}
								interrupted={isAborted}
							/>
							{!isError && !isPartial && entry?.result != null ? (
								<ToolResultMedia args={args} result={entry.result} toolName={toolName} />
							) : null}
						</>
					)}
				</div>
			)}
		</div>
	);
}
