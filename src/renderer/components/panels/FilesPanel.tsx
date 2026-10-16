/**
 * Files panel: workspace file tree sourced via the dedicated `fs:list` /
 * `fs:read` main-process IPC (node:fs — cross-platform, works with no live
 * agent session), the in-drawer file viewer (panels/viewers), and @mention
 * insertion via the "omp:insert-mention" window event.
 */

import {
	ArrowLeft,
	AtSign,
	Copy,
	ExternalLink as ExternalLinkIcon,
	FilePlus,
	Folder,
	FolderOpen,
	FolderPlus,
	Maximize2,
	Minimize2,
	Pencil,
	Pin,
	RefreshCw,
	TextSearch,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipcErrorCode } from "../../../shared/ipc-error-codes";
import type { FsTreeEntry, IpcFsMutation } from "../../../shared/ipc-types";
import type { RpcGitChanges } from "../../../shared/rpc-types";
import { useMediaQuery } from "../../hooks/use-media-query";
import { errorMessage } from "../../lib/error-detail";
import { FILE_DRAG_TYPE } from "../../lib/file-drag";
import { copyText, formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { actionKbd, PLATFORM } from "../../lib/keymap";
import { useRuntimeTabId, useSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { COMPACT_SHELL_QUERY, useUiStore } from "../../stores/ui";
import {
	Banner,
	Button,
	ConfirmDialog,
	ContextMenu,
	type ContextMenuAnchor,
	type ContextMenuItem,
	EmptyState,
	ErrorDetail,
	IconButton,
	SearchField,
	Spinner,
} from "../common";
import { type TreeNode, TreeView } from "../common/TreeView";
import { PathLink } from "../tools/media/PathLink";
import { FileContentSearch } from "./FileContentSearch";
import { PanelToolbar } from "./PanelChrome";
import { EDITABLE_KINDS, FileEditor } from "./viewers/FileEditor";
import { FileIcon, FileViewer } from "./viewers/FileViewer";
import { viewerKind } from "./viewers/file-kind";
import type { FileInfo } from "./viewers/viewer-chrome";

const MAX_FILES = 2000;
const MAX_DEPTH = 8;

interface Entry {
	kind: "file" | "dir";
	/** Workspace-relative POSIX path. */
	path: string;
}
type Editing = { op: "createFile" | "createFolder"; parent: string } | { op: "rename"; path: string };

/** A git status letter on a tree row: Modified, Added, Deleted, Renamed, Untracked, Conflicted. */
export type GitMark = "M" | "A" | "D" | "R" | "U" | "C";
const GIT_MARK_STYLE: Record<GitMark, { color: string; label: string }> = {
	M: { color: "text-(--sc-warning)", label: "filesPanel.git.modified" },
	A: { color: "text-(--sc-success)", label: "filesPanel.git.added" },
	D: { color: "text-(--sc-danger)", label: "filesPanel.git.deleted" },
	R: { color: "text-(--sc-info)", label: "filesPanel.git.renamed" },
	U: { color: "text-(--sc-success)", label: "filesPanel.git.untracked" },
	C: { color: "text-(--sc-danger)", label: "filesPanel.git.conflicted" },
};
export interface GitDecorations {
	/** Workspace-relative file path → its mark. */
	files: Map<string, GitMark>;
	/** Folders holding a changed file somewhere below. */
	dirs: Set<string>;
}
const NO_GIT: GitDecorations = { files: new Map(), dirs: new Set() };

/** The tree's view of `get_git_changes`: paths re-rooted from the checkout to the tab's folder (C39). */
export function gitDecorations(changes: RpcGitChanges, cwd: string): GitDecorations {
	const root = (changes.root ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
	const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!changes.isRepo || !root || (base !== root && !base.startsWith(`${root}/`))) return NO_GIT;
	const prefix = base === root ? "" : `${base.slice(root.length + 1)}/`;
	const result: GitDecorations = { files: new Map(), dirs: new Set() };
	for (const file of changes.files) {
		if (!file.path.startsWith(prefix)) continue;
		const path = file.path.slice(prefix.length);
		const [x, y] = file.status;
		const code = y !== " " ? y : x;
		const mark: GitMark =
			file.status === "??"
				? "U"
				: x === "U" || y === "U" || file.status === "AA" || file.status === "DD"
					? "C"
					: code === "A" || code === "D" || code === "R"
						? code
						: code === "C"
							? "A"
							: "M";
		result.files.set(path, mark);
		const segments = path.split("/");
		for (let index = 1; index < segments.length; index++) result.dirs.add(segments.slice(0, index).join("/"));
	}
	return result;
}

/** Inline name field for a new or renamed entry: Enter or leaving it commits a changed name, Escape cancels. */
function EntryNameField({
	initial,
	label,
	onSubmit,
	onCancel,
}: {
	initial: string;
	label: string;
	onSubmit: (name: string) => void;
	onCancel: () => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	const done = useRef(false);
	/** Blur commits only once the field held focus, so a menu handing focus back while closing never cancels it. */
	const focused = useRef(false);
	useEffect(() => {
		// A closing menu restores focus to its trigger in the same commit; take it back on the next frame.
		const frame = requestAnimationFrame(() => {
			const input = ref.current;
			if (!input) return;
			input.focus();
			// The base name is selected, so typing keeps the extension (mixdog's explorer does the same).
			const dot = initial.lastIndexOf(".");
			input.setSelectionRange(0, dot > 0 ? dot : initial.length);
		});
		return () => cancelAnimationFrame(frame);
	}, [initial]);
	const finish = (submit: boolean) => {
		if (done.current) return;
		done.current = true;
		const value = ref.current?.value.trim() ?? "";
		if (submit && value && value !== initial) onSubmit(value);
		else onCancel();
	};
	return (
		<input
			ref={ref}
			aria-label={label}
			defaultValue={initial}
			spellCheck={false}
			autoCapitalize="none"
			className="h-(--sc-control-xs,1.5rem) w-full min-w-0 rounded-(--sc-radius-sm) border border-(--sc-border) bg-(--sc-field) px-1.5 text-sc-sm text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
			data-files-name-field
			onFocus={() => {
				focused.current = true;
			}}
			onBlur={() => {
				if (focused.current) finish(true);
			}}
			onClick={event => event.stopPropagation()}
			onKeyDown={event => {
				if (event.key === "Enter") {
					event.preventDefault();
					finish(true);
				} else if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					finish(false);
				}
			}}
		/>
	);
}

function countFiles(entries: FsTreeEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.kind === "file") count++;
		else if (entry.children) count += countFiles(entry.children);
	}
	return count;
}

/** Search the bounded tree already loaded from the workspace; preserve full paths. */
export function searchFiles(entries: FsTreeEntry[], query: string): FsTreeEntry[] {
	const needle = query.trim().toLocaleLowerCase();
	return entries.flatMap(entry =>
		entry.kind === "file"
			? entry.path.toLocaleLowerCase().includes(needle)
				? [entry]
				: []
			: searchFiles(entry.children ?? [], query),
	);
}

/**
 * `path` as a workspace-relative POSIX path ("" for the root itself), or null
 * when it lies outside `cwd`. Accepts tab-relative (`./src/`), absolute and
 * Windows-separated forms.
 */
export function workspaceRelativePath(path: string, cwd: string): string | null {
	const clean = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
	const target = clean(path);
	const root = clean(cwd);
	const absolute = target.startsWith("/") || /^[A-Za-z]:\//.test(target);
	if (!absolute) return target.replace(/^(\.\/)+/, "").replace(/^\.$/, "");
	if (!root) return null;
	if (target === root) return "";
	return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : null;
}

/** Files whose default app runs them as programs; opening one outside the viewer asks first (C44). */
const EXECUTABLE =
	/\.(app|bat|cmd|com|command|cpl|exe|jar|js|jse|lnk|msc|msi|pif|pkg|ps1|scpt|scr|sh|tool|url|vbe|vbs|workflow|wsf)$/i;
/** How often an open file is checked for changes on disk while the window is visible. */
const DISK_WATCH_MS = 2000;

/**
 * Keyed by path in FilesPanel: a new file starts with fresh header info and views. `keepArm` holds the
 * path a tree click just opened; the second press of that double-click lands here (the viewer replaced
 * the tree under the pointer) and keeps the tab (D29).
 */
function FilePreview({
	path,
	tabId,
	keepArm,
}: {
	path: string;
	tabId: string | undefined;
	keepArm: { current: string | null };
}) {
	const t = useT();
	const remote = useTabsStore(s => Boolean(s.tabs.find(tab => tab.id === tabId)?.device));
	const closeFilePreview = useUiStore(s => s.closeFilePreview);
	const expanded = useUiStore(s => s.filePreviewExpanded);
	const toggleExpanded = useUiStore(s => s.toggleFilePreviewExpanded);
	const compact = useMediaQuery(COMPACT_SHELL_QUERY);
	const line = useUiStore(s => s.filePreviewLine);
	const fileTabs = useUiStore(s => s.fileTabs);
	const openFilePreview = useUiStore(s => s.openFilePreview);
	const keepFileOpen = useUiStore(s => s.keepFileOpen);
	const closeFileTab = useUiStore(s => s.closeFileTab);
	const isPreviewTab = fileTabs.some(tab => tab.path === path && tab.preview);
	const [info, setInfo] = useState<FileInfo | null>(null);
	/** Bumped when the file changes on disk; remounts the view so it reads again. */
	const [revision, setRevision] = useState(0);
	const [gone, setGone] = useState(false);
	const [confirmRun, setConfirmRun] = useState(false);
	const [editing, setEditing] = useState(false);
	const [dirty, setDirty] = useState(false);
	/** What waits for "Discard" while the editor holds unsaved changes. */
	const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
	/** Another file (a link, Quick Open, search hit) waiting for "Discard"; the store held it back. */
	const pendingSwitch = useUiStore(s => s.pendingFileSwitch !== null);
	const setFileEditDirty = useUiStore(s => s.setFileEditDirty);
	const resolveFileSwitch = useUiStore(s => s.resolveFileSwitch);
	/** The file's last known modification time; a save sets it, so its own write is no outside change. */
	const stampRef = useRef<number | null>(null);
	const kind = viewerKind(path);

	// C18: a change on disk reloads the view (the editor decides for itself); a vanished file says so.
	useEffect(() => {
		let active = true;
		stampRef.current = null;
		const check = async () => {
			if (document.hidden) return;
			try {
				const result = await window.omp.fs.stat(path, tabId);
				if (!active) return;
				if (!result.ok) {
					if (result.code === "file_not_found") setGone(true);
					return;
				}
				setGone(false);
				if (stampRef.current !== null && result.mtimeMs !== stampRef.current) setRevision(value => value + 1);
				stampRef.current = result.mtimeMs;
			} catch {
				// A failed check keeps the view as it is; the next tick tries again.
			}
		};
		void check();
		const timer = window.setInterval(() => void check(), DISK_WATCH_MS);
		return () => {
			active = false;
			window.clearInterval(timer);
		};
	}, [path, tabId]);

	// Unsaved edits hold back a switch to another file until the user answers (store `pendingFileSwitch`).
	useEffect(() => setFileEditDirty(editing && dirty), [editing, dirty, setFileEditDirty]);
	useEffect(
		() => () => {
			setFileEditDirty(false);
			resolveFileSwitch(false);
		},
		[setFileEditDirty, resolveFileSwitch],
	);

	/** Runs `action` now, or after the user agrees to drop unsaved edits. */
	const leaveEditor = (action: () => void) => {
		if (editing && dirty) setPendingLeave(() => action);
		else action();
	};
	const onSaved = useCallback((mtimeMs: number, size: number) => {
		stampRef.current = mtimeMs;
		setInfo(previous => ({ ...previous, size }));
	}, []);
	const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

	const insertMention = () => {
		window.dispatchEvent(new CustomEvent("omp:insert-mention", { detail: { path, tabId } }));
		leaveEditor(closeFilePreview);
	};
	const runExternal = async () => {
		setConfirmRun(false);
		try {
			const result = await window.omp.system.openPath(path, tabId);
			if (!result.ok) toastError({ title: t("tools.path.openFailed"), error: result });
		} catch (cause) {
			toastError({ title: t("tools.path.openFailed"), error: cause });
		}
	};

	const kindLabel = t(`fileViewer.kind.${kind}`);
	return (
		<div
			className="omp-slide-in-right flex h-full min-h-0 min-w-0 flex-col"
			onMouseDownCapture={event => {
				if (keepArm.current === path && event.detail >= 2) keepFileOpen(path);
				keepArm.current = null;
			}}
		>
			{fileTabs.length > 1 && (
				<nav
					aria-label={t("filesPanel.tabs")}
					className="flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-b border-(--sc-divider) px-2 py-1"
					data-file-tabs
				>
					{fileTabs.map(tab => {
						const active = tab.path === path;
						const name = tab.path.split("/").pop() ?? tab.path;
						return (
							<div
								key={tab.path}
								className={`flex max-w-48 min-w-24 shrink-0 items-center rounded-(--sc-radius-sm) border ${active ? "border-(--sc-border) bg-(--sc-selected)" : "border-transparent hover:bg-(--sc-hover)"}`}
								data-file-tab={tab.path}
								data-preview-file-tab={tab.preview ? "" : undefined}
							>
								<button
									type="button"
									aria-current={active ? "page" : undefined}
									className={`flex h-(--sc-control-sm) min-w-0 flex-1 items-center gap-1.5 truncate rounded-(--sc-radius-sm) px-2 text-left text-sc-xs focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) ${tab.preview ? "italic" : ""} ${active ? "text-(--sc-text)" : "text-(--sc-text-muted) hover:text-(--sc-text)"}`}
									title={tab.preview ? `${tab.path} — ${t("filesPanel.previewTab")}` : tab.path}
									onClick={() => {
										if (!active) openFilePreview(tab.path);
									}}
									onDoubleClick={() => keepFileOpen(tab.path)}
								>
									<FileIcon className="size-(--sc-icon-sm) shrink-0" path={tab.path} />
									<span className="truncate">{name}</span>
								</button>
								<IconButton
									label={t("filesPanel.closeTab", { name })}
									icon={<X />}
									size="sm"
									onClick={() => closeFileTab(tab.path)}
								/>
							</div>
						);
					})}
				</nav>
			)}
			<div className="min-h-(--sc-space-10) shrink-0 border-b border-(--sc-divider) px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<IconButton
						icon={<ArrowLeft />}
						label={t("filesPanel.back")}
						onClick={() => leaveEditor(closeFilePreview)}
						size="sm"
					/>
					<FileIcon className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)" path={path} />
					<span
						className={`min-w-0 flex-1 truncate text-sc-sm ${isPreviewTab ? "italic" : ""}`}
						data-file-preview-title
						title={isPreviewTab ? `${path} — ${t("filesPanel.previewTab")}` : path}
					>
						{path}
					</span>
					<div className="flex shrink-0 items-center gap-0.5">
						{isPreviewTab && (
							<IconButton
								icon={<Pin />}
								label={t("filesPanel.keepOpen")}
								onClick={() => keepFileOpen(path)}
								size="sm"
							/>
						)}
						{/* A paired host's file: this computer's apps can't open it there (viewer-chrome.tsx). */}
						{remote ? null : EXECUTABLE.test(path) ? (
							<IconButton
								icon={<ExternalLinkIcon />}
								label={t("filesPanel.openExternal")}
								onClick={() => setConfirmRun(true)}
								size="sm"
							/>
						) : (
							<PathLink
								path={path}
								className="flex size-(--sc-control-sm) shrink-0 items-center justify-center rounded-(--sc-radius-md) text-(--sc-text-muted) hover:bg-(--sc-hover) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
							>
								<ExternalLinkIcon className="size-(--sc-icon-sm)" />
								<span className="sr-only">{t("filesPanel.openExternal")}</span>
							</PathLink>
						)}
						{EDITABLE_KINDS[kind] && (
							<IconButton
								icon={<Pencil />}
								label={t("fileViewer.edit")}
								onClick={() => {
									if (editing) leaveEditor(() => setEditing(false));
									else {
										// Editing a file keeps its tab: the next file opened never replaces work in progress.
										keepFileOpen(path);
										setEditing(true);
									}
								}}
								pressed={editing}
								size="sm"
							/>
						)}
						<IconButton
							icon={<AtSign />}
							label={t("filesPanel.insertMention")}
							onClick={insertMention}
							size="sm"
						/>
						{!compact && (
							<IconButton
								icon={expanded ? <Minimize2 /> : <Maximize2 />}
								label={t(expanded ? "fileViewer.collapse" : "fileViewer.expand")}
								onClick={toggleExpanded}
								pressed={expanded}
								size="sm"
							/>
						)}
					</div>
				</div>
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ps-9">
					<span
						className="me-auto max-w-full truncate text-sc-xs text-(--sc-text-subtle) tabular-nums"
						data-file-meta
						title={info?.mime}
					>
						{info ? `${kindLabel} · ${formatBytes(info.size)}` : kindLabel}
					</span>
				</div>
			</div>
			{gone && (
				<div className="shrink-0 px-3 pt-2">
					<Banner live variant="warning">
						{t("filesPanel.gone")}
					</Banner>
				</div>
			)}
			<div className="min-h-0 flex-1 bg-(--sc-surface-1)">
				{editing ? (
					<FileEditor
						diskRevision={revision}
						kind={kind}
						onDirtyChange={onDirtyChange}
						onSaved={onSaved}
						path={path}
						tabId={tabId}
					/>
				) : (
					<FileViewer key={revision} line={line ?? undefined} onInfo={setInfo} path={path} tabId={tabId} />
				)}
			</div>
			<ConfirmDialog
				open={confirmRun}
				title={t("filesPanel.runTitle")}
				message={t("filesPanel.runMessage", { name: path.split("/").pop() ?? path })}
				confirmLabel={t("filesPanel.runConfirm")}
				onConfirm={() => void runExternal()}
				onCancel={() => setConfirmRun(false)}
			/>
			<ConfirmDialog
				open={pendingLeave !== null || pendingSwitch}
				title={t("fileViewer.discardTitle")}
				message={t("fileViewer.discardMessage", { name: path.split("/").pop() ?? path })}
				confirmLabel={t("fileViewer.discard")}
				onConfirm={() => {
					const action = pendingLeave;
					setPendingLeave(null);
					setDirty(false);
					setEditing(false);
					action?.();
					resolveFileSwitch(true);
				}}
				onCancel={() => {
					setPendingLeave(null);
					resolveFileSwitch(false);
				}}
			/>
		</div>
	);
}

export function FilesPanel() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const filePreviewPath = useUiStore(s => s.filePreviewPath);
	const openFilePreview = useUiStore(s => s.openFilePreview);
	const revealPath = useUiStore(s => s.filesRevealPath);
	const searchSeq = useUiStore(s => s.filesSearchSeq);
	const keymapOverrides = useUiStore(s => s.keymapOverrides);
	/** The body searches file contents instead of showing the tree. */
	const [contentSearch, setContentSearch] = useState(searchSeq > 0);
	useEffect(() => {
		if (searchSeq > 0) setContentSearch(true);
	}, [searchSeq]);
	const cwd = useTabsStore(s => s.tabs.find(tab => tab.id === tabId)?.cwd ?? "");
	const listVersion = useRef(0);
	const [query, setQuery] = useState("");
	const [tree, setTree] = useState<FsTreeEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [truncated, setTruncated] = useState(false);
	/** The failed list result or thrown cause; null when the tree loaded. */
	const [error, setError] = useState<unknown>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	/** Folder a reply's link revealed (or the last folder clicked); marked in the tree. */
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const runtime = useSessionRuntime();
	const remote = useTabsStore(s => Boolean(s.tabs.find(tab => tab.id === tabId)?.device));
	const [git, setGit] = useState<GitDecorations>(NO_GIT);
	const [editing, setEditing] = useState<Editing | null>(null);
	const [menu, setMenu] = useState<{ anchor: ContextMenuAnchor; entry: Entry } | null>(null);
	const [trashing, setTrashing] = useState<Entry | null>(null);

	const loadGit = useCallback(async () => {
		if (!runtime) return;
		try {
			const response = await runtime.command({ type: "get_git_changes" });
			setGit(response.success ? gitDecorations(response.data as RpcGitChanges, cwd) : NO_GIT);
		} catch {
			setGit(NO_GIT);
		}
	}, [runtime, cwd]);
	const load = useCallback(async () => {
		const version = ++listVersion.current;
		setLoading(true);
		setError(null);
		try {
			const result = tabId
				? await window.omp.fs.list(undefined, MAX_DEPTH, MAX_FILES, tabId)
				: await window.omp.fs.list(undefined, MAX_DEPTH, MAX_FILES);
			if (version !== listVersion.current) return;
			if (!result.ok) {
				setError(result);
				setTree([]);
				setTruncated(false);
				return;
			}
			setTree(result.entries);
			setTruncated(result.truncated);
		} catch (err) {
			if (version !== listVersion.current) return;
			setError(err);
			setTree([]);
			setTruncated(false);
		} finally {
			if (version === listVersion.current) setLoading(false);
		}
	}, [tabId]);

	useEffect(() => {
		setTree([]);
		setExpanded(new Set());
		setSelectedId(null);
		setEditing(null);
		void load();
		return () => {
			listVersion.current++;
		};
	}, [load]);

	useEffect(() => {
		setGit(NO_GIT);
		void loadGit();
	}, [loadGit]);

	const refresh = () => {
		void load();
		void loadGit();
	};

	/** Expand every folder above `path` (and `path` itself when `self`). */
	const expandTo = (path: string, self: boolean) => {
		const segments = path.split("/").filter(Boolean);
		const count = self ? segments.length : segments.length - 1;
		const ids = segments.slice(0, count).map((_, index) => `dir:${segments.slice(0, index + 1).join("/")}`);
		setExpanded(prev => new Set([...prev, ...ids]));
	};

	const mutate = async (mutation: IpcFsMutation) => {
		setEditing(null);
		try {
			const result = await window.omp.fs.mutate(mutation, tabId ?? undefined);
			if (!result.ok || !result.path) {
				toastError({ title: t("filesPanel.changeFailed"), error: result });
				return;
			}
			await load();
			void loadGit();
			if (mutation.op === "trash") {
				setSelectedId(null);
				return;
			}
			const kind =
				mutation.op === "createFolder" || (mutation.op === "rename" && editingKind.current === "dir")
					? "dir"
					: "file";
			expandTo(result.path, false);
			setSelectedId(`${kind}:${result.path}`);
		} catch (cause) {
			toastError({ title: t("filesPanel.changeFailed"), error: cause });
		}
	};
	/** Kind of the entry being renamed, read once the rename lands. */
	const editingKind = useRef<Entry["kind"]>("file");
	const startCreate = (op: "createFile" | "createFolder", parent: string) => {
		setQuery("");
		if (parent) expandTo(parent, true);
		setEditing({ op, parent });
	};
	const startRename = (entry: Entry) => {
		setQuery("");
		editingKind.current = entry.kind;
		setEditing({ op: "rename", path: entry.path });
	};
	/** Folder new entries go into: the selected folder, else the project root. */
	const createParent = selectedId?.startsWith("dir:") ? selectedId.slice(4) : "";

	const menuItems = (entry: Entry): ContextMenuItem[] => {
		const items: ContextMenuItem[] = [];
		if (entry.kind === "dir")
			items.push(
				{
					id: "new-file",
					label: t("filesPanel.newFile"),
					icon: FilePlus,
					onSelect: () => startCreate("createFile", entry.path),
				},
				{
					id: "new-folder",
					label: t("filesPanel.newFolder"),
					icon: FolderPlus,
					onSelect: () => startCreate("createFolder", entry.path),
				},
			);
		else
			items.push({
				id: "mention",
				label: t("filesPanel.insertMention"),
				icon: AtSign,
				onSelect: () =>
					window.dispatchEvent(new CustomEvent("omp:insert-mention", { detail: { path: entry.path, tabId } })),
			});
		items.push(
			{
				id: "rename",
				label: t("filesPanel.rename"),
				icon: Pencil,
				separatorBefore: true,
				onSelect: () => startRename(entry),
			},
			{
				id: "trash",
				label: t("filesPanel.trash"),
				icon: Trash2,
				danger: true,
				onSelect: () => setTrashing(entry),
			},
		);
		if (!remote)
			items.push({
				id: "reveal",
				label: t(PLATFORM === "windows" ? "markdown.path.revealExplorer" : "markdown.path.revealFinder"),
				icon: FolderOpen,
				separatorBefore: true,
				onSelect: () =>
					void window.omp.system.revealPath(entry.path, tabId ?? undefined).then(
						result => {
							if (!result.ok) toastError({ title: t("markdown.link.nativeFailed"), error: result });
						},
						cause => toastError({ title: t("markdown.link.nativeFailed"), error: cause }),
					),
			});
		items.push({
			id: "copy",
			label: t("markdown.path.copy"),
			icon: Copy,
			separatorBefore: remote,
			onSelect: () =>
				void copyText(entry.path).then(ok =>
					toast(
						ok
							? { variant: "success", message: t("common.copied") }
							: { variant: "error", message: t("common.copyFailed") },
					),
				),
		});
		return items;
	};

	// A folder link in a reply: once the tree is loaded, expand down to the
	// folder, select it and scroll it into view, then clear the request.
	useEffect(() => {
		if (!revealPath || loading) return;
		useUiStore.setState({ filesRevealPath: null });
		const relative = workspaceRelativePath(revealPath, cwd);
		if (!relative) return;
		const segments = relative.split("/");
		const ids = segments.map((_, index) => `dir:${segments.slice(0, index + 1).join("/")}`);
		setQuery("");
		setExpanded(prev => new Set([...prev, ...ids]));
		setSelectedId(ids[ids.length - 1]);
	}, [revealPath, loading, cwd]);

	/** Path a tree click just opened; FilePreview keeps it when that click turns out to be a double-click. */
	const keepArm = useRef<string | null>(null);
	// Wire file activation: clicking a file previews it, clicking a dir toggles.
	const onNodeClick = useCallback(
		(id: string) => {
			if (id.startsWith("file:")) {
				keepArm.current = id.slice(5);
				openFilePreview(id.slice(5));
			} else if (id.startsWith("dir:")) {
				setSelectedId(id);
				setExpanded(prev => {
					const next = new Set(prev);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
			}
		},
		[openFilePreview],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mutate is rebuilt each render and reads the latest tab; the listed state decides the rows.
	const nodes = useMemo<TreeNode[]>(() => {
		const field = (initial: string, label: string, submit: (name: string) => void) => (
			<EntryNameField initial={initial} label={label} onCancel={() => setEditing(null)} onSubmit={submit} />
		);
		const createNode = (op: "createFile" | "createFolder", parent: string): TreeNode => ({
			id: "edit:new",
			label: field(
				"",
				t(op === "createFile" ? "filesPanel.newFile" : "filesPanel.newFolder"),
				name => void mutate({ op, parent, name }),
			),
			icon:
				op === "createFolder" ? (
					<Folder className="size-(--sc-icon-sm)" />
				) : (
					<FileIcon path="" className="size-(--sc-icon-sm)" />
				),
		});
		const toNode = (entry: FsTreeEntry): TreeNode => {
			const id = `${entry.kind}:${entry.path}`;
			const isDir = entry.kind === "dir";
			const renaming = editing?.op === "rename" && editing.path === entry.path;
			const children = entry.children?.map(toNode) ?? [];
			if (isDir && editing && editing.op !== "rename" && editing.parent === entry.path)
				children.unshift(createNode(editing.op, entry.path));
			const mark = git.files.get(entry.path);
			return {
				id,
				label: renaming
					? field(
							entry.name,
							t("filesPanel.rename"),
							name => void mutate({ op: "rename", path: entry.path, name }),
						)
					: entry.name,
				icon: isDir ? (
					expanded.has(id) ? (
						<FolderOpen className="size-(--sc-icon-sm)" />
					) : (
						<Folder className="size-(--sc-icon-sm)" />
					)
				) : (
					<FileIcon path={entry.path} className="size-(--sc-icon-sm)" />
				),
				trailing: mark ? (
					<span
						className={`ms-1 shrink-0 font-mono text-sc-xs ${GIT_MARK_STYLE[mark].color}`}
						data-git-mark={mark}
						title={t(GIT_MARK_STYLE[mark].label)}
					>
						{mark}
						<span className="sr-only">{t(GIT_MARK_STYLE[mark].label)}</span>
					</span>
				) : isDir && git.dirs.has(entry.path) ? (
					<span
						className="ms-1 size-1.5 shrink-0 rounded-full bg-(--sc-text-subtle)"
						data-git-mark="dir"
						title={t("filesPanel.git.inside")}
					/>
				) : undefined,
				onClick: renaming ? undefined : () => onNodeClick(id),
				onMenu: anchor =>
					setMenu({ anchor, entry: { kind: entry.kind === "dir" ? "dir" : "file", path: entry.path } }),
				onDragStart: renaming
					? undefined
					: event => {
							event.dataTransfer.setData(FILE_DRAG_TYPE, JSON.stringify({ path: entry.path, tabId }));
							event.dataTransfer.setData("text/plain", entry.path);
							event.dataTransfer.effectAllowed = "copy";
						},
				children: children.length > 0 ? children : undefined,
			};
		};
		const roots = query.trim()
			? searchFiles(tree, query).map(entry => ({ ...toNode(entry), label: entry.path }))
			: tree.map(toNode);
		return editing && editing.op !== "rename" && editing.parent === ""
			? [createNode(editing.op, ""), ...roots]
			: roots;
	}, [tree, query, expanded, onNodeClick, editing, git, t, tabId]);

	const fileCount = useMemo(() => countFiles(tree), [tree]);

	if (filePreviewPath)
		return <FilePreview key={filePreviewPath} keepArm={keepArm} path={filePreviewPath} tabId={tabId ?? undefined} />;

	return (
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			<PanelToolbar>
				{/* The empty state already says there is nothing; a bare number never stands alone. */}
				{fileCount > 0 && (
					<span className="px-1 text-sc-xs tabular-nums text-(--sc-text-subtle)" data-file-count>
						{t(truncated ? "filesPanel.countMore" : "filesPanel.count", {
							count: fileCount,
							plural: fileCount === 1 ? "" : "s",
						})}
					</span>
				)}
				<IconButton
					disabled={loading}
					icon={<RefreshCw />}
					label={t("filesPanel.refresh")}
					onClick={refresh}
					size="sm"
				/>
				<IconButton
					disabled={error !== null}
					icon={<FilePlus />}
					label={t("filesPanel.newFile")}
					onClick={() => startCreate("createFile", createParent)}
					size="sm"
				/>
				<IconButton
					disabled={error !== null}
					icon={<FolderPlus />}
					label={t("filesPanel.newFolder")}
					onClick={() => startCreate("createFolder", createParent)}
					size="sm"
				/>
				<IconButton
					icon={<TextSearch />}
					label={t("filesPanel.contentSearch.toggle")}
					onClick={() => setContentSearch(value => !value)}
					pressed={contentSearch}
					shortcut={actionKbd("files.search", keymapOverrides)}
					size="sm"
				/>
				{!contentSearch && (
					<div className="min-w-0 flex-1">
						<SearchField
							controlSize="sm"
							label={t("filesPanel.search")}
							placeholder={t("filesPanel.search")}
							value={query}
							onValueChange={setQuery}
						/>
						{truncated && (
							<p className="mt-1 text-sc-xs text-(--sc-text-muted)">
								{t("filesPanel.searchLimit", { files: MAX_FILES, depth: MAX_DEPTH })}
							</p>
						)}
					</div>
				)}
			</PanelToolbar>
			{contentSearch ? (
				<FileContentSearch focusSeq={searchSeq} tabId={tabId ?? undefined} />
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
					{loading && tree.length === 0 ? (
						<Spinner className="w-full justify-center py-8" label={t("filesPanel.scanning")} size="sm" />
					) : error !== null ? (
						<div className="px-4 py-8 text-center text-sc-sm leading-relaxed text-(--sc-text-muted)">
							{ipcErrorCode(error) ? errorMessage(error) : t("filesPanel.unavailable")}
							<ErrorDetail className="mt-1" error={error} />
							<div className="mt-2">
								<Button onClick={() => void load()} size="sm" variant="ghost">
									{t("common.retry")}
								</Button>
							</div>
						</div>
					) : nodes.length === 0 ? (
						<EmptyState
							icon={<Folder />}
							size="sm"
							title={t(query.trim() ? "filesPanel.noMatch" : "filesPanel.empty")}
							actions={
								query.trim() ? (
									<Button size="sm" variant="secondary" onClick={() => setQuery("")}>
										{t("common.clear")}
									</Button>
								) : undefined
							}
						/>
					) : (
						<TreeView
							emptyMessage={t("filesPanel.empty")}
							className="omp-files-tree"
							expanded={expanded}
							nodes={nodes}
							onExpandedChange={setExpanded}
							selectedId={selectedId}
						/>
					)}
				</div>
			)}
			{menu && (
				<ContextMenu
					ariaLabel={menu.entry.path}
					items={menuItems(menu.entry).map(item => ({
						...item,
						onSelect: () => {
							setMenu(null);
							item.onSelect();
						},
					}))}
					onClose={() => setMenu(null)}
					x={menu.anchor.x}
					y={menu.anchor.y}
				/>
			)}
			<ConfirmDialog
				open={trashing !== null}
				title={t(trashing?.kind === "dir" ? "filesPanel.trashFolderTitle" : "filesPanel.trashFileTitle")}
				message={t("filesPanel.trashMessage", { name: trashing?.path ?? "" })}
				confirmLabel={t("filesPanel.trash")}
				onConfirm={() => {
					const entry = trashing;
					setTrashing(null);
					if (entry) void mutate({ op: "trash", path: entry.path });
				}}
				onCancel={() => setTrashing(null)}
			/>
		</div>
	);
}
