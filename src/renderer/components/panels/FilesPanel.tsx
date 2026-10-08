/**
 * Files panel: workspace file tree sourced via the dedicated `fs:list` /
 * `fs:read` main-process IPC (node:fs — cross-platform, works with no live
 * agent session), the in-drawer file viewer (panels/viewers), and @mention
 * insertion via the "omp:insert-mention" window event.
 */

import {
	ArrowLeft,
	AtSign,
	ExternalLink as ExternalLinkIcon,
	Folder,
	FolderOpen,
	Maximize2,
	Minimize2,
	RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipcErrorCode } from "../../../shared/ipc-error-codes";
import type { FsTreeEntry } from "../../../shared/ipc-types";
import { useMediaQuery } from "../../hooks/use-media-query";
import { errorMessage } from "../../lib/error-detail";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { COMPACT_SHELL_QUERY, useUiStore } from "../../stores/ui";
import { Button, ErrorDetail, IconButton, Spinner } from "../common";
import { type TreeNode, TreeView } from "../common/TreeView";
import { PathLink } from "../tools/PathLink";
import { FileIcon, FileViewer } from "./viewers/FileViewer";
import { viewerKind } from "./viewers/file-kind";
import type { FileInfo } from "./viewers/viewer-chrome";

const MAX_FILES = 2000;
const MAX_DEPTH = 8;

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

/** Keyed by path in FilesPanel: a new file starts with fresh header info and views. */
function FilePreview({ path, tabId }: { path: string; tabId: string | undefined }) {
	const t = useT();
	const closeFilePreview = useUiStore(s => s.closeFilePreview);
	const expanded = useUiStore(s => s.filePreviewExpanded);
	const toggleExpanded = useUiStore(s => s.toggleFilePreviewExpanded);
	const compact = useMediaQuery(COMPACT_SHELL_QUERY);
	const [info, setInfo] = useState<FileInfo | null>(null);

	const insertMention = () => {
		window.dispatchEvent(new CustomEvent("omp:insert-mention", { detail: { path, tabId } }));
		closeFilePreview();
	};

	const kindLabel = t(`fileViewer.kind.${viewerKind(path)}`);
	return (
		<div className="omp-slide-in-right flex h-full min-h-0 flex-col">
			<div className="shrink-0 border-b border-(--omp-border-muted) px-3 py-1.5">
				<div className="flex min-w-0 items-center gap-2">
					<button
						type="button"
						onClick={closeFilePreview}
						aria-label={t("filesPanel.back")}
						className="omp-pressable flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-(--omp-muted) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
					>
						<ArrowLeft size={14} />
					</button>
					<FileIcon className="shrink-0 text-(--omp-dim)" path={path} size={12} />
					<span className="min-w-0 flex-1 truncate font-mono text-omp-xs" title={path}>
						{path}
					</span>
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
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 ps-9">
					<span
						// Never squeezed: when the actions don't fit beside it, they wrap below.
						className="me-auto max-w-full truncate text-omp-xs text-(--omp-dim) tabular-nums"
						data-file-meta
						title={info?.mime}
					>
						{info ? `${kindLabel} · ${formatBytes(info.size)}` : kindLabel}
					</span>
					<div className="ms-auto flex shrink-0 items-center gap-1">
						<PathLink
							path={path}
							className="inline-flex shrink-0 items-center gap-1 px-1.5 py-1 text-omp-xs text-(--omp-muted)"
						>
							<ExternalLinkIcon size={12} />
							<span>{t("filesPanel.openExternal")}</span>
						</PathLink>
						<button
							type="button"
							onClick={insertMention}
							className="omp-pressable inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-omp-xs text-(--omp-muted) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
						>
							<AtSign size={12} />
							<span>{t("filesPanel.insertMention")}</span>
						</button>
					</div>
				</div>
			</div>
			<div className="min-h-0 flex-1 bg-(--omp-code-bg)">
				<FileViewer onInfo={setInfo} path={path} tabId={tabId} />
			</div>
		</div>
	);
}

export function FilesPanel() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const filePreviewPath = useUiStore(s => s.filePreviewPath);
	const openFilePreview = useUiStore(s => s.openFilePreview);
	const listVersion = useRef(0);
	const [query, setQuery] = useState("");
	const [tree, setTree] = useState<FsTreeEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [truncated, setTruncated] = useState(false);
	/** The failed list result or thrown cause; null when the tree loaded. */
	const [error, setError] = useState<unknown>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

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
		void load();
		return () => {
			listVersion.current++;
		};
	}, [load]);

	// Wire file activation: clicking a file previews it, clicking a dir toggles.
	const onNodeClick = useCallback(
		(id: string) => {
			if (id.startsWith("file:")) openFilePreview(id.slice(5));
			else if (id.startsWith("dir:")) {
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

	const nodes = useMemo<TreeNode[]>(() => {
		const toNode = (entry: FsTreeEntry): TreeNode => {
			const id = `${entry.kind}:${entry.path}`;
			const isDir = entry.kind === "dir";
			return {
				id,
				label: entry.name,
				icon: isDir ? (
					expanded.has(id) ? (
						<FolderOpen size={12} />
					) : (
						<Folder size={12} />
					)
				) : (
					<FileIcon path={entry.path} size={12} />
				),
				onClick: () => onNodeClick(id),
				children: entry.children && entry.children.length > 0 ? entry.children.map(toNode) : undefined,
			};
		};
		return query.trim()
			? searchFiles(tree, query).map(entry => ({ ...toNode(entry), label: entry.path }))
			: tree.map(toNode);
	}, [tree, query, expanded, onNodeClick]);

	const fileCount = useMemo(() => countFiles(tree), [tree]);

	if (filePreviewPath) return <FilePreview key={filePreviewPath} path={filePreviewPath} tabId={tabId ?? undefined} />;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
				<span className="text-omp-xs font-medium tracking-widest text-(--omp-dim) uppercase">
					{t("filesPanel.title")}
				</span>
				<div className="flex items-center gap-1.5">
					<span className="text-omp-xs tabular-nums text-(--omp-dim)">
						{fileCount}
						{truncated ? "+" : ""}
					</span>
					<button
						aria-label={t("filesPanel.refresh")}
						className="rounded p-0.5 text-(--omp-dim) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
						disabled={loading}
						onClick={() => void load()}
						type="button"
					>
						<RefreshCw className={loading ? "animate-spin" : undefined} size={11} />
					</button>
				</div>
			</div>
			<div className="px-3 pb-2">
				<input
					aria-label={t("filesPanel.search")}
					placeholder={t("filesPanel.search")}
					className="w-full rounded border border-(--omp-input-border) bg-(--omp-input-bg) px-2 py-1.5 text-omp-sm"
					value={query}
					onChange={event => setQuery(event.target.value)}
				/>
				{truncated && (
					<p className="mt-1 text-omp-xs text-(--omp-muted)">
						{t("filesPanel.searchLimit", { files: MAX_FILES, depth: MAX_DEPTH })}
					</p>
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
				{loading && tree.length === 0 ? (
					<div className="flex items-center justify-center gap-2 py-8">
						<Spinner size="sm" />
						<span className="text-omp-sm text-(--omp-dim)">{t("filesPanel.scanning")}</span>
					</div>
				) : error !== null ? (
					<div className="px-4 py-8 text-center text-omp-sm leading-relaxed text-(--omp-dim)">
						{ipcErrorCode(error) ? errorMessage(error) : t("filesPanel.unavailable")}
						<ErrorDetail className="mt-1" error={error} />
						<div className="mt-2">
							<Button onClick={() => void load()} size="sm" variant="ghost">
								{t("filesPanel.retry")}
							</Button>
						</div>
					</div>
				) : (
					<TreeView
						emptyMessage={t("filesPanel.empty")}
						expanded={expanded}
						nodes={nodes}
						onExpandedChange={setExpanded}
					/>
				)}
			</div>
		</div>
	);
}
