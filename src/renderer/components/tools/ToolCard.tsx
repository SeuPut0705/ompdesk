import { Ban, ChevronRight, CircleX } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
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
 * the intent leaves, so a narrow row clips the target first and the intent last.
 */
export const AFTER_INTENT_CLASS = "basis-0 grow text-(--sc-text-muted)";

/**
 * The one status/kind icon slot of a step row: live, failed, stopped, or the kind icon when done. A done
 * row says so to a screen reader here; the other states say it in words on the row.
 */
export function ToolStatusIcon({
	state,
	runningIndicator,
	kindIcon,
}: {
	state: "running" | "error" | "aborted" | "done";
	runningIndicator: RunningIndicator;
	kindIcon: ReactNode;
}) {
	const t = useT();
	return (
		<span
			{...(state === "done" ? { role: "img", "aria-label": t("tools.status.done") } : { "aria-hidden": true })}
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
 * "Open file" link (the whole path in its tooltip), so opening the file stays one click without saying it twice.
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
		<PathLink path={openPath} className="omp-tool-open-file shrink-0 font-sans text-sc-xs text-(--sc-text-muted)">
			{t("tools.path.open")}
		</PathLink>
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
	// Measured as the row opens: whether its target shows whole, so the body need not repeat it.
	const [targetShown, setTargetShown] = useState(false);
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
	// A target that only restates the intent (a wait's `i`) is said once.
	const target = intent && header.target.toLocaleLowerCase() === intent.toLocaleLowerCase() ? "" : header.target;
	const toggle = (row: HTMLElement) => {
		if (!expanded) {
			const summary = row.querySelector<HTMLElement>(".omp-tool-summary");
			setTargetShown(
				summary !== null && summary.scrollWidth <= summary.clientWidth && !summary.textContent?.endsWith("…"),
			);
		}
		setExpanded(value => !value);
	};
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
				type="button"
				aria-expanded={expanded}
				onClick={event => toggle(event.currentTarget)}
				className={TOOL_ROW_CLASS}
			>
				<ToolStatusIcon
					kindIcon={<KindIcon />}
					runningIndicator={runningIndicator}
					state={failed ? "error" : isAborted ? "aborted" : status === "running" ? "running" : "done"}
				/>
				<span
					className={cx(
						intent ? "omp-tool-intent min-w-0 truncate" : "omp-tool-name shrink-0",
						"font-medium",
						failed ? "text-(--sc-danger)" : "text-(--sc-text-secondary)",
					)}
					title={intent}
				>
					{intent ?? (header.labelKey ? t(header.labelKey, header.labelParams) : header.tool)}
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
								rowShowsTarget={header.path ? true : targetShown}
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
