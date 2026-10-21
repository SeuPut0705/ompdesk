/**
 * Diff panel: latest edit-tool diffs from the tools store, with a file
 * selector when several edits exist, and unified/split view toggle.
 * Unified rendering delegates to lib/diff DiffView; split mode is built
 * on parseDiff directly.
 *
 * The Timeline view is a chronological feed of every edit/write/apply_patch
 * operation this session (same tools-store source), grouped by file with
 * per-file cumulative and session-total +/- summaries plus an activity
 * strip; the feed is virtualized to handle many edits.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Columns2, FileCode2, Rows3 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShellMode } from "../../hooks/use-shell-mode";
import { type DiffLine, DiffView, parseDiff } from "../../lib/diff";
import { formatClock, formatTimeAgo, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_TEXT_CHARS } from "../../lib/preview";
import { useSessionStore } from "../../stores/session";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { type ChangesMode, useUiStore } from "../../stores/ui";
import { EmptyState, IconButton, Select } from "../common";
import { workspaceRelativePath } from "./FilesPanel";
import { PANEL_ROW, PanelToolbar } from "./PanelChrome";
import { RepositoryChanges } from "./RepositoryChanges";
import { CommitHistory } from "./scm/CommitHistory";

const DIFF_TOOLS = new Set(["edit", "apply_patch", "ast_edit", "write"]);

export interface DiffCandidate {
	id: string;
	toolName: string;
	file: string;
	diff: string;
	timestamp: number;
	adds: number;
	removes: number;
	isError: boolean;
	isContent: boolean;
	isVirtual: boolean;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Best-effort file name from tool args, result details, or hashline input header. */
function deriveFile(args: Record<string, unknown>, diff: string, details: Record<string, unknown> | undefined): string {
	const path =
		asString(args.path) ??
		asString(args.file_path) ??
		asString(args.file) ??
		asString(details?.path) ??
		asString(details?.resolvedPath);
	if (path) return path;
	const header = diff.match(/^\[([^\]#]+)#/);
	return header?.[1] ?? "edit";
}

/**
 * Parsed candidates per finished tool entry. The tools store replaces an
 * entry whenever it changes, so an identity hit (same map key) is always
 * current and a finished edit is parsed once, not on every tool event.
 */
const candidatesByEntry = new WeakMap<ToolEntry, { id: string; candidates: DiffCandidate[] }>();

function entryCandidates(id: string, entry: ToolEntry): DiffCandidate[] {
	const cached = candidatesByEntry.get(entry);
	if (cached?.id === id) return cached.candidates;
	const candidates: DiffCandidate[] = [];
	const details = resultDetails(entry.result);
	const files = Array.isArray(details?.perFileResults) ? details.perFileResults : [details ?? {}];
	for (const [index, raw] of files.entries()) {
		if (!raw || typeof raw !== "object") continue;
		const fileResult = raw as Record<string, unknown>;
		const isError = fileResult.error != null || fileResult.isError === true || (entry.isError && files.length === 1);
		const actualDiff = asString(fileResult.diff);
		const isContent = isError || !actualDiff;
		const diff = isError
			? (asString(fileResult.error) ?? resultText(entry.result))
			: (actualDiff ?? (entry.toolName === "write" ? asString(entry.args.content) : null));
		if (diff === null) continue;
		const file = asString(fileResult.path) ?? deriveFile(entry.args, diff, details);
		let adds = 0;
		let removes = 0;
		if (!isContent) {
			for (const row of parseDiff(diff)) {
				if (row.type === "add") adds++;
				else if (row.type === "remove") removes++;
			}
		}
		candidates.push({
			id: `${id}:${index}`,
			toolName: entry.toolName,
			file,
			diff,
			timestamp: entry.endTime ?? entry.startTime,
			adds,
			removes,
			isError,
			isContent,
			isVirtual: /^[a-z][a-z0-9+.-]*:\/\//i.test(file) && !file.startsWith("file://"),
		});
	}
	candidatesByEntry.set(entry, { id, candidates });
	return candidates;
}

/** Edit/write entries with a result: the only ones the panel shows. */
function isFinishedDiff(entry: ToolEntry): boolean {
	return DIFF_TOOLS.has(entry.toolName) && (entry.status === "done" || entry.status === "error");
}

/** Keep multi-file results distinct; failed or pending writes are never counted as applied changes. */
export function buildEditCandidates(tools: ReadonlyMap<string, ToolEntry>): DiffCandidate[] {
	const out: DiffCandidate[] = [];
	for (const [id, entry] of tools) if (isFinishedDiff(entry)) out.push(...entryCandidates(id, entry));
	return out.sort((a, b) => b.timestamp - a.timestamp);
}

interface CandidatesSnapshot {
	tools: ReadonlyMap<string, ToolEntry>;
	version: number;
	ids: string[];
	entries: ToolEntry[];
	candidates: DiffCandidate[];
}

/**
 * Edit candidates that change only when a finished edit/write entry does.
 * Diffs only come from finished entries, and the store bumps
 * `finishedVersion` whenever that map changes, so live traffic (streamed
 * args, partial results) costs one comparison. When it did change, finished
 * diff entries are re-checked by identity — no parsing — and the previous
 * array is returned when none changed, so other tools finishing never
 * re-render the panel.
 */
function useEditCandidates(): DiffCandidate[] {
	const snapshot = useRef<CandidatesSnapshot | null>(null);
	return useToolsStore(state => {
		const previous = snapshot.current;
		const tools = state.finishedTools;
		const version = state.finishedVersion;
		if (previous?.tools === tools && previous.version === version) return previous.candidates;
		let same = previous !== null;
		let count = 0;
		for (const [id, entry] of tools) {
			if (!isFinishedDiff(entry)) continue;
			if (same && (previous?.entries[count] !== entry || previous.ids[count] !== id)) same = false;
			count++;
		}
		if (same && previous && count === previous.entries.length) {
			snapshot.current = { ...previous, tools, version };
			return previous.candidates;
		}
		const next: CandidatesSnapshot = { tools, version, ids: [], entries: [], candidates: buildEditCandidates(tools) };
		for (const [id, entry] of tools) {
			if (!isFinishedDiff(entry)) continue;
			next.ids.push(id);
			next.entries.push(entry);
		}
		snapshot.current = next;
		return next.candidates;
	});
}

function EditPreview({ entry }: { entry: DiffCandidate }) {
	const t = useT();
	return entry.isContent ? (
		<div>
			<p className={`text-sc-xs ${entry.isError ? "text-(--sc-danger)" : "text-(--sc-text-muted)"}`}>
				{t(entry.isError ? "diffPanel.failedEdit" : "diffPanel.writtenContent")}
			</p>
			<pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-sc-sm">
				{entry.diff.slice(0, PREVIEW_TEXT_CHARS)}
			</pre>
			{entry.diff.length > PREVIEW_TEXT_CHARS && <p>{t("diffPanel.previewLimited")}</p>}
		</div>
	) : (
		<DiffView diff={entry.diff} filePath={entry.file} />
	);
}

/** Pair remove/add runs into side-by-side rows for split view. */
function toSplitRows(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
	const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
	let removes: DiffLine[] = [];
	const flush = (adds: DiffLine[]) => {
		const width = Math.max(removes.length, adds.length);
		for (let i = 0; i < width; i++) {
			rows.push({ left: removes[i] ?? null, right: adds[i] ?? null });
		}
		removes = [];
	};
	let adds: DiffLine[] = [];
	for (const line of lines) {
		if (line.type === "remove") {
			if (adds.length > 0) {
				flush(adds);
				adds = [];
			}
			removes.push(line);
		} else if (line.type === "add") {
			adds.push(line);
		} else {
			if (removes.length > 0 || adds.length > 0) {
				flush(adds);
				adds = [];
			}
			rows.push({ left: line, right: line });
		}
	}
	if (removes.length > 0 || adds.length > 0) flush(adds);
	return rows;
}

const LINE_CLASS: Record<DiffLine["type"], string> = {
	add: "bg-(--sc-success-soft) text-(--sc-success)",
	remove: "bg-(--sc-danger-soft) text-(--sc-danger)",
	context: "text-(--sc-text-muted)",
};

function SplitDiff({ diff }: { diff: string }) {
	const rows = useMemo(() => toSplitRows(parseDiff(diff)), [diff]);
	return (
		<div className="grid grid-cols-2 gap-px overflow-x-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-border-subtle) font-mono text-sc-sm leading-(--sc-leading-normal)">
			{(["left", "right"] as const).map(side => (
				<div className="min-w-0 bg-(--sc-surface-2)" key={side}>
					{rows.map((row, index) => {
						const line = row[side];
						return (
							<div
								className={`px-2 whitespace-pre ${line ? LINE_CLASS[line.type] : "text-transparent"}`}
								key={index}
							>
								{line
									? `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.content}`
									: "·"}
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}

// ─── Timeline view ──────────────────────────────────────────────────────────

interface FileGroup {
	file: string;
	edits: DiffCandidate[];
	adds: number;
	removes: number;
	latest: number;
}

/** Group edits (already newest-first) by file; groups sorted by latest activity. */
function buildFileGroups(candidates: DiffCandidate[]): FileGroup[] {
	const byFile = new Map<string, FileGroup>();
	for (const candidate of candidates) {
		let group = byFile.get(candidate.file);
		if (!group) {
			group = { file: candidate.file, edits: [], adds: 0, removes: 0, latest: 0 };
			byFile.set(candidate.file, group);
		}
		group.edits.push(candidate);
		group.adds += candidate.adds;
		group.removes += candidate.removes;
		group.latest = Math.max(group.latest, candidate.timestamp);
	}
	return [...byFile.values()].sort((a, b) => b.latest - a.latest);
}

type TimelineRow = { kind: "file"; group: FileGroup } | { kind: "edit"; entry: DiffCandidate };

const ACTIVITY_BINS = 36;

/** Compact sparkline/heat strip of edit activity across the session time span. */
function EditActivityStrip({ edits }: { edits: DiffCandidate[] }) {
	const t = useT();
	const activity = useMemo(() => {
		const bins = Array.from({ length: ACTIVITY_BINS }, () => ({ adds: 0, removes: 0, edits: 0 }));
		// `edits` arrives newest-first.
		const start = edits[edits.length - 1]?.timestamp ?? 0;
		const end = edits[0]?.timestamp ?? start;
		const span = Math.max(1, end - start);
		let peak = 1;
		for (const edit of edits) {
			const index = Math.min(ACTIVITY_BINS - 1, Math.floor(((edit.timestamp - start) / span) * ACTIVITY_BINS));
			const bin = bins[index];
			if (!bin) continue;
			bin.adds += edit.adds;
			bin.removes += edit.removes;
			bin.edits += 1;
			peak = Math.max(peak, bin.adds + bin.removes);
		}
		return { bins, peak, start, span };
	}, [edits]);

	return (
		<div aria-hidden className="flex h-7 items-stretch gap-px">
			{activity.bins.map((bin, index) => {
				const total = bin.adds + bin.removes;
				const binStart = activity.start + (activity.span * index) / ACTIVITY_BINS;
				const binEnd = activity.start + (activity.span * (index + 1)) / ACTIVITY_BINS;
				return (
					<div
						className="flex min-w-0 flex-1 flex-col justify-end"
						key={index}
						title={
							total === 0
								? undefined
								: t("diffPanel.activity", {
										edits: bin.edits,
										plural: bin.edits === 1 ? "" : "s",
										adds: bin.adds,
										removes: bin.removes,
										start: formatClock(binStart),
										end: formatClock(binEnd),
									})
						}
					>
						{total > 0 && (
							<div
								className="flex w-full flex-col overflow-hidden rounded-(--sc-radius-sm)"
								style={{ height: `${Math.max(15, (total / activity.peak) * 100)}%` }}
							>
								<div className="bg-(--sc-danger)" style={{ height: `${(bin.removes / total) * 100}%` }} />
								<div className="bg-(--sc-success)" style={{ height: `${(bin.adds / total) * 100}%` }} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

/**
 * An edited file's path as the session sees it: relative to the session's folder,
 * with the folder part giving way to an ellipsis first so the file name is always shown.
 */
export function FilePath({ file, cwd }: { file: string; cwd: string | null }) {
	const shown = (cwd ? workspaceRelativePath(file, cwd) : null) || file;
	const slash = shown.lastIndexOf("/");
	const dirPrefix = shown.slice(0, slash + 1);
	return (
		<span className="flex min-w-0 font-mono" title={file}>
			{dirPrefix && <span className="min-w-0 truncate text-(--sc-text-muted)">{dirPrefix}</span>}
			<span className="max-w-full shrink-0 truncate">{shown.slice(slash + 1)}</span>
		</span>
	);
}

function FileGroupHeader({
	group,
	collapsed,
	onToggle,
}: {
	group: FileGroup;
	collapsed: boolean;
	onToggle: () => void;
}) {
	const cwd = useSessionStore(state => state.cwd);
	return (
		<button aria-expanded={!collapsed} className={PANEL_ROW} onClick={onToggle} title={group.file} type="button">
			{collapsed ? (
				<ChevronRight className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
			) : (
				<ChevronDown className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
			)}
			<FileCode2 className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
			<span className="min-w-0 text-sc-sm text-(--sc-text)">
				<FilePath cwd={cwd} file={group.file} />
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-sc-xs">
				<span className="text-(--sc-success)">+{group.adds}</span>
				<span className="text-(--sc-danger)">-{group.removes}</span>
				<span className="px-1 py-px text-sc-2xs text-(--sc-text-muted)">×{group.edits.length}</span>
			</span>
		</button>
	);
}

function EditTimelineRow({
	entry,
	expanded,
	onToggle,
}: {
	entry: DiffCandidate;
	expanded: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	return (
		<div className="pb-0.5 pl-4">
			<button aria-expanded={expanded} className={PANEL_ROW} onClick={onToggle} type="button">
				{expanded ? (
					<ChevronDown className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
				) : (
					<ChevronRight className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
				)}
				<span className="flex shrink-0 items-center gap-1 font-mono text-sc-xs">
					<span className="text-(--sc-success)">+{entry.adds}</span>
					<span className="text-(--sc-danger)">-{entry.removes}</span>
				</span>
				<span className="shrink-0 px-1.5 py-px text-sc-2xs text-(--sc-text-muted)">{entry.toolName}</span>
				{entry.isError && (
					<span className="shrink-0 px-1 py-px text-sc-2xs text-(--sc-danger)">{t("diffPanel.error")}</span>
				)}
				<span className="ml-auto shrink-0 text-sc-xs text-(--sc-text-muted)" title={formatClock(entry.timestamp)}>
					{formatTimeAgo(entry.timestamp)}
				</span>
			</button>
			{expanded && (
				<div className="mt-0.5 overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle) bg-(--sc-surface-2) py-1">
					<EditPreview entry={entry} />
				</div>
			)}
		</div>
	);
}

function DiffTimeline({ candidates }: { candidates: DiffCandidate[] }) {
	const t = useT();
	const groups = useMemo(() => buildFileGroups(candidates), [candidates]);
	const totals = useMemo(() => {
		let adds = 0;
		let removes = 0;
		for (const candidate of candidates) {
			adds += candidate.adds;
			removes += candidate.removes;
		}
		return { adds, removes };
	}, [candidates]);

	const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const rows = useMemo<TimelineRow[]>(() => {
		const out: TimelineRow[] = [];
		for (const group of groups) {
			out.push({ kind: "file", group });
			if (collapsedFiles.has(group.file)) continue;
			for (const entry of group.edits) out.push({ kind: "edit", entry });
		}
		return out;
	}, [groups, collapsedFiles]);

	const parentRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: index => {
			const row = rows[index];
			if (!row) return 28;
			if (row.kind === "file") return 30;
			return row.entry.id === expandedId ? 280 : 26;
		},
		overscan: 10,
		measureElement: element => element.getBoundingClientRect().height,
	});

	// Expanding/collapsing a diff changes row heights without changing the count.
	useEffect(() => {
		// The virtualizer reads expandedId indirectly through estimateSize.
		void expandedId;
		virtualizer.measure();
	}, [virtualizer, expandedId]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="space-y-1.5 px-3 pb-2">
				<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
					<span>
						{t("diffPanel.summary", {
							edits: candidates.length,
							editPlural: candidates.length === 1 ? "" : "s",
							files: groups.length,
							filePlural: groups.length === 1 ? "" : "s",
						})}
					</span>
					<span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono">
						<span className="text-(--sc-success)">+{totals.adds}</span>
						<span className="text-(--sc-danger)">-{totals.removes}</span>
					</span>
				</div>
				<EditActivityStrip edits={candidates} />
			</div>

			<div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
				<div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
					{virtualizer.getVirtualItems().map(item => {
						const row = rows[item.index];
						if (!row) return null;
						return (
							<div
								data-index={item.index}
								key={row.kind === "file" ? `file:${row.group.file}` : row.entry.id}
								ref={virtualizer.measureElement}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${item.start}px)`,
								}}
							>
								{row.kind === "file" ? (
									<FileGroupHeader
										collapsed={collapsedFiles.has(row.group.file)}
										group={row.group}
										onToggle={() =>
											setCollapsedFiles(previous => {
												const next = new Set(previous);
												if (next.has(row.group.file)) next.delete(row.group.file);
												else next.add(row.group.file);
												return next;
											})
										}
									/>
								) : (
									<EditTimelineRow
										entry={row.entry}
										expanded={expandedId === row.entry.id}
										onToggle={() =>
											setExpandedId(previous => (previous === row.entry.id ? null : row.entry.id))
										}
									/>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export function DiffPanel() {
	const t = useT();
	const allCandidates = useEditCandidates();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// A phone is too narrow for two columns: it reads the unified diff only.
	const phone = useShellMode() === "phone";
	const [splitChosen, setSplit] = useState(false);
	const split = splitChosen && !phone;
	const mode = useUiStore(state => state.changesMode);
	const setMode = useUiStore(state => state.setChangesMode);
	const sessionId = useSessionStore(state => state.sessionId);
	const cwd = useSessionStore(state => state.cwd);
	const candidates = useMemo(
		() => allCandidates.filter(entry => (mode === "artifacts" ? entry.isVirtual : !entry.isVirtual)),
		[allCandidates, mode],
	);

	const selected = candidates.find(c => c.id === selectedId) ?? candidates[0] ?? null;
	const sourceSelector = (
		<Select
			aria-label={t("diffPanel.title")}
			controlSize="sm"
			value={mode}
			onChange={event => setMode(event.target.value as ChangesMode)}
			options={(["repository", "commits", "current", "timeline", "artifacts"] as const).map(value => ({
				value,
				label: t(`diffPanel.mode.${value}`),
			}))}
		/>
	);

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			{mode !== "repository" && mode !== "commits" && (
				<PanelToolbar>
					{sourceSelector}
					{mode === "current" && !phone && (
						<div className="ml-auto flex shrink-0 items-center gap-1">
							<IconButton
								icon={<Rows3 />}
								label={t("diffPanel.unified")}
								onClick={() => setSplit(false)}
								pressed={!split}
								size="sm"
							/>
							<IconButton
								icon={<Columns2 />}
								label={t("diffPanel.split")}
								onClick={() => setSplit(true)}
								pressed={split}
								size="sm"
							/>
						</div>
					)}
				</PanelToolbar>
			)}

			{mode === "repository" ? (
				<RepositoryChanges key={sessionId} sourceSelector={sourceSelector} />
			) : mode === "commits" ? (
				<CommitHistory key={sessionId} sourceSelector={sourceSelector} />
			) : candidates.length === 0 ? (
				<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
					<EmptyState icon={<FileCode2 />} size="sm" title={t("diffPanel.empty")} />
				</div>
			) : mode === "timeline" || mode === "artifacts" ? (
				<DiffTimeline candidates={candidates} />
			) : (
				<>
					{candidates.length > 1 && (
						<div className="px-3 pb-1.5">
							<Select
								aria-label={t("diffPanel.selectFile")}
								controlSize="sm"
								className="w-full"
								onChange={event => setSelectedId(event.target.value)}
								value={selected?.id ?? ""}
								options={candidates.map(candidate => ({
									value: candidate.id,
									label: `${workspaceRelativePath(candidate.file, cwd ?? "") || candidate.file} — ${candidate.toolName}`,
								}))}
							/>
						</div>
					)}

					<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
						{selected && (
							<div className="space-y-1.5">
								<div className="flex min-w-0 items-center gap-1.5 text-sc-sm text-(--sc-text-muted)">
									<FileCode2 className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
									<span className="min-w-0">
										<FilePath cwd={cwd} file={selected.file} />
									</span>
									<span className="ml-auto shrink-0 px-1.5 py-px text-sc-2xs text-(--sc-text-muted)">
										{selected.toolName}
									</span>
								</div>
								{split && !selected.isContent ? (
									<SplitDiff diff={selected.diff} />
								) : (
									<EditPreview entry={selected} />
								)}
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
