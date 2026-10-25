import { Ban, ChevronRight, CircleX } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { basename, cx, dirname, durationBetween, resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { selectDesktopSlotPosition, useDesktopSlotStore } from "../../stores/desktop-slot";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { selectToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { stepIntent } from "../chat/work/work-steps";
import { Spinner } from "../common";
import { type DiffStats, toolDiffStats } from "./diff-stats";
import { getToolHeader, getToolRenderer } from "./index";
import { PathLink } from "./media/PathLink";
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
	/**
	 * The row this body opens under shows the call's target: its file, or its whole command. The body
	 * then starts with what the row did not say instead of repeating it.
	 */
	rowShowsTarget?: boolean;
}

export interface ToolCardProps {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	/** A parent activity indicator can own animation for a live tool group. */
	runningIndicator?: RunningIndicator;
	/** Lead the closed row with the call's intent (`stepIntent`); off under a row that already says it. */
	showIntent?: boolean;
	/** The thoughts just before this step, folded into its row: counted there, shown first when it opens. */
	thoughts?: StepThoughts;
}

export interface StepThoughts {
	count: number;
	body: ReactNode;
}

/** File-changing tools whose results carry stock's LSP `diagnostics`. */
const DIAGNOSTIC_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true };

export type RunningIndicator = "spinner" | "dot";

/** Row chrome shared by every work step (tool rows, grouped reads) so they read as one list.
 * The hover wash hugs the row's content instead of spanning the whole column. */
export const TOOL_ROW_CLASS =
	"omp-tool-header flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-(--sc-radius-sm) px-1.5 text-left text-sc-sm transition-colors duration-(--sc-duration-instant) hover:bg-(--sc-hover)";

/**
 * Under an intent, the target is the row's muted second part: it starts from no width and takes only the room
 * the intent leaves, so a narrow row clips the target first and the intent last. A target squeezed to a sliver
 * ("g.", ":") is not drawn (`useSliverGuard`); it keeps its slot, so hiding it moves nothing, and stays read aloud.
 */
export const AFTER_INTENT_CLASS = "basis-0 grow text-(--sc-text-muted) data-sliver:opacity-0";

/** Below this a clipped target says nothing: about four characters of the row's monospace text. */
const TARGET_MIN_PX = 32;

/** A step row's target: its file, command or pattern, else the tool's name after the intent; never the slot wait. */
const ROW_TARGET = ".omp-tool-summary:not([data-desktop-slot-waiting]), .omp-tool-kind";

let sliverObserver: ResizeObserver | undefined;

function markSliver(summary: Element): void {
	summary.toggleAttribute(
		"data-sliver",
		summary.clientWidth < TARGET_MIN_PX && summary.scrollWidth > summary.clientWidth,
	);
}

/**
 * Marks a step row's target `data-sliver` while the row leaves it too little room to say anything. One observer for
 * every row, watching the target's own box (its room shrinks when the intent, the state or the time beside it grows,
 * though the row keeps its width), and only a DOM attribute: a 165-step card re-renders nothing when its rows are
 * measured. `text` is what the target shows: a new text is observed afresh, which measures it again.
 */
export function useSliverGuard(row: RefObject<HTMLElement | null>, text: string): void {
	useEffect(() => {
		const summary = text ? row.current?.querySelector(ROW_TARGET) : null;
		if (!summary || typeof ResizeObserver === "undefined") return;
		sliverObserver ??= new ResizeObserver(entries => {
			for (const { target } of entries) markSliver(target);
		});
		sliverObserver.observe(summary);
		return () => sliverObserver?.unobserve(summary);
	}, [row, text]);
}

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
export function ToolPathTarget({
	path,
	moreFiles,
	suffix,
	afterIntent,
}: {
	path: string;
	moreFiles?: number;
	suffix?: string;
	afterIntent?: boolean;
}) {
	const folder = dirname(path);
	const more = moreFiles ? ` +${moreFiles}` : "";
	return (
		<span
			className={cx("omp-tool-summary min-w-0 truncate font-mono", afterIntent && AFTER_INTENT_CLASS)}
			title={`${path}${suffix ?? ""}${more}`}
		>
			<span className={afterIntent ? undefined : "text-(--sc-text)"}>
				{basename(path)}
				{suffix}
			</span>
			{folder && folder !== "." ? <span className="ms-1.5 text-(--sc-text-subtle)">{folder}</span> : null}
			{more ? <span className="ms-1.5 text-(--sc-text-muted)">{more.trim()}</span> : null}
		</span>
	);
}

/**
 * The file an opened body names: its path as a link, or, when the row above already shows that path, only an
 * "Open file" link (the file's name read aloud with it, the whole path in its tooltip) and the line it starts at,
 * so opening the file stays one click without saying the path twice.
 */
export function BodyPathLink({
	path,
	openPath = path,
	rowShowsTarget,
	suffix,
}: {
	path: string;
	openPath?: string;
	rowShowsTarget?: boolean;
	suffix?: string;
}) {
	const t = useT();
	if (!rowShowsTarget) {
		return (
			<PathLink path={openPath} className="truncate">
				<ToolPathTarget path={path} suffix={suffix} />
			</PathLink>
		);
	}
	return (
		<>
			<PathLink path={openPath} className="omp-tool-open-file shrink-0 font-sans text-sc-xs text-(--sc-text-muted)">
				{t("tools.path.open")}
				<span className="sr-only"> {basename(path)}</span>
			</PathLink>
			{suffix ? <span className="shrink-0 font-mono text-sc-xs text-(--sc-text-subtle)">{suffix}</span> : null}
		</>
	);
}

/** How many thoughts a step row folded in. */
export function ThoughtCount({ count }: { count: number }) {
	const t = useT();
	return (
		<span className="omp-step-thoughts shrink-0 text-sc-xs tabular-nums text-(--sc-text-subtle)">
			{t("chat.work.thoughts", { count })}
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
 * One work step: status or kind icon, then what the agent meant to do (its intent) with the target
 * (file name first, command, pattern) as the muted second part, or, for a call that states no intent,
 * the tool's label and the target; diff stat, folded thoughts, duration, expand/collapse. The body comes
 * from the tool registry; the tool_result arrives via the tools store keyed by toolCallId.
 */
export function ToolCard({
	toolCallId,
	toolName,
	args,
	runningIndicator = "spinner",
	showIntent = true,
	thoughts,
}: ToolCardProps) {
	const t = useT();
	const entry = useToolsStore(s => selectToolEntry(s, toolCallId));
	const expandAll = useUiStore(s => s.toolsExpandAll);
	// A running `eval` of a session queued for the desktop slot is not running yet: it waits for its turn.
	const tabId = useRuntimeTabId();
	const slotPosition = useDesktopSlotStore(s =>
		toolName === "eval" && entry?.status === "running" ? selectDesktopSlotPosition(s, tabId) : null,
	);
	const [expanded, setExpanded] = useState(expandAll.expanded);
	// Whether the row shows its target whole, measured while the body is open (the row narrows with the window, a
	// split or the side panel), so the body repeats only what the row cannot show.
	const [targetShown, setTargetShown] = useState(false);
	const rowRef = useRef<HTMLButtonElement>(null);
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
	const intent = showIntent ? stepIntent({ intent: entry?.intent, arguments: args }) : undefined;
	// A target that only restates the intent (a wait's `i`, cut to its first line or 160 characters) is said once.
	const targetCore = header.target.replace(/…$/, "").toLocaleLowerCase();
	const restates =
		intent !== undefined &&
		targetCore !== "" &&
		(intent.toLocaleLowerCase() === targetCore ||
			((header.target.endsWith("…") || intent.includes("\n")) && intent.toLocaleLowerCase().startsWith(targetCore)));
	const target = restates ? "" : header.target;
	const label = header.labelKey ? t(header.labelKey, header.labelParams) : header.tool;
	// With no other target the tool's label follows the intent on the row; otherwise a screen reader hears it first.
	const labelAfterIntent = intent !== undefined && !header.path && !target && !streamingSummary;
	// The text the row's target shows: a change measures it again even when its box keeps its size.
	const targetText = header.path ?? (target || streamingSummary || (labelAfterIntent ? label : ""));
	useSliverGuard(rowRef, targetText);
	useLayoutEffect(() => {
		const summary = targetText ? rowRef.current?.querySelector<HTMLElement>(ROW_TARGET) : null;
		if (!expanded) return;
		const measure = () =>
			setTargetShown(
				summary != null &&
					summary.clientWidth > 0 &&
					summary.scrollWidth <= summary.clientWidth &&
					!summary.textContent?.endsWith("…"),
			);
		measure();
		if (!summary || typeof ResizeObserver === "undefined") return;
		// The target's own box: it narrows when the window, a split or the side panel narrows the row, and when the
		// intent, the state or the time beside it takes more of a row already at its widest.
		const observer = new ResizeObserver(measure);
		observer.observe(summary);
		return () => observer.disconnect();
	}, [expanded, targetText]);
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
			<button
				ref={rowRef}
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded(value => !value)}
				className={TOOL_ROW_CLASS}
			>
				<ToolStatusIcon
					kindIcon={<KindIcon />}
					runningIndicator={runningIndicator}
					state={failed ? "error" : isAborted ? "aborted" : status === "running" ? "running" : "done"}
				/>
				{intent && !labelAfterIntent ? <span className="sr-only">{`${label}, `}</span> : null}
				<span
					className={cx(
						intent ? "omp-tool-intent min-w-0 truncate" : "omp-tool-name shrink-0",
						"font-medium",
						failed ? "text-(--sc-danger)" : "text-(--sc-text-secondary)",
					)}
					title={intent}
				>
					{intent ?? label}
				</span>
				{slotPosition !== null && !failed ? (
					<span
						className="omp-tool-summary min-w-0 truncate text-(--sc-text-muted)"
						data-desktop-slot-waiting={slotPosition}
					>
						{t("desktopSlot.waiting", { position: slotPosition })}
					</span>
				) : null}
				{header.path ? (
					<ToolPathTarget afterIntent={!!intent} moreFiles={header.moreFiles} path={header.path} />
				) : target ? (
					<span
						className={cx(
							"omp-tool-summary min-w-0 truncate font-mono",
							intent ? AFTER_INTENT_CLASS : "text-(--sc-text-muted)",
						)}
						title={target}
					>
						{target}
					</span>
				) : streamingSummary ? (
					<span className="omp-tool-summary min-w-0 truncate font-mono text-(--sc-text-subtle)">
						{streamingSummary}…
					</span>
				) : labelAfterIntent ? (
					// No other target: the tool that ran (an MCP server's tool, a device) stays named after the intent.
					<span className={cx("omp-tool-kind min-w-0 truncate", AFTER_INTENT_CLASS)} title={label}>
						{label}
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
				) : status === "running" ? (
					<span className="sr-only">{t("chat.exec.running")}</span>
				) : (
					<span className="sr-only">{t("tools.status.done")}</span>
				)}
				{thoughts ? <ThoughtCount count={thoughts.count} /> : null}
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
					{thoughts?.body}
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
								rowShowsTarget={targetShown}
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
