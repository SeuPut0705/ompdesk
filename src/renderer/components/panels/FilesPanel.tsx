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
import { Button, EmptyState, ErrorDetail, IconButton, SearchField, Spinner } from "../common";
import { type TreeNode, TreeView } from "../common/TreeView";
import { PathLink } from "../tools/PathLink";
import { PanelToolbar } from "./PanelChrome";
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
		<div className="omp-slide-in-right flex h-full min-h-0 min-w-0 flex-col">
			<div className="min-h-(--sc-space-10) shrink-0 border-b border-(--sc-divider) px-3 py-2">
				<div className="flex min-w-0 items-center gap-2">
					<IconButton icon={<ArrowLeft />} label={t("filesPanel.back")} onClick={closeFilePreview} size="sm" />
					<FileIcon className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-subtle)" path={path} />
					<span className="min-w-0 flex-1 truncate text-sc-sm" title={path}>
						{path}
					</span>
					<div className="flex shrink-0 items-center gap-0.5">
						<PathLink
							path={path}
							className="flex size-(--sc-control-sm) shrink-0 items-center justify-center rounded-(--sc-radius-md) text-(--sc-text-muted) hover:bg-(--sc-hover) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
						>
							<ExternalLinkIcon className="size-(--sc-icon-sm)" />
							<span className="sr-only">{t("filesPanel.openExternal")}</span>
						</PathLink>
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
			<div className="min-h-0 flex-1 bg-(--sc-surface-1)">
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
						<FolderOpen className="size-(--sc-icon-sm)" />
					) : (
						<Folder className="size-(--sc-icon-sm)" />
					)
				) : (
					<FileIcon path={entry.path} className="size-(--sc-icon-sm)" />
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
		<div className="flex h-full min-h-0 min-w-0 flex-col">
			<PanelToolbar>
				{/* The empty state already says there is nothing; a bare number never stands alone. */}
				{fileCount > 0 && (
					<span className="px-1 text-sc-xs tabular-nums text-(--sc-text-subtle)" data-file-count>
						{t(truncated ? "filesPanel.countMore" : "filesPanel.count", { count: fileCount })}
					</span>
				)}
				<IconButton
					disabled={loading}
					icon={<RefreshCw />}
					label={t("filesPanel.refresh")}
					onClick={() => void load()}
					size="sm"
				/>
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
			</PanelToolbar>
			<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
				{loading && tree.length === 0 ? (
					<div className="flex items-center justify-center gap-2 py-8">
						<Spinner size="sm" />
						<span className="text-sc-sm text-(--sc-text-muted)">{t("filesPanel.scanning")}</span>
					</div>
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
					/>
				)}
			</div>
		</div>
	);
}
