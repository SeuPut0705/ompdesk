/**
 * Shared chrome for the Files drawer viewers: the loading / error / too-large
 * states every view must end in, the truncation note with Load more, the
 * per-view toolbar and its fit-relative zoom controls, and the channel a view
 * uses to tell the header the file's size and type.
 */
import { ExternalLink as ExternalLinkIcon, ZoomIn, ZoomOut } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { InlineFailure } from "../../../lib/error-detail";
import { formatBytes } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Button, ErrorDetail, IconButton, Spinner } from "../../common";
import { PathLink } from "../../tools/PathLink";

export interface FileInfo {
	size: number;
	/** Sniffed MIME from a binary read, when one happened. */
	mime?: string;
}

/** Set by FileViewer; views report the size/MIME their read returned. */
export const FileInfoContext = createContext<(info: FileInfo) => void>(() => {});

export function useReportFileInfo(size: number | null, mime?: string): void {
	const report = useContext(FileInfoContext);
	useEffect(() => {
		if (size !== null) report({ size, mime });
	}, [report, size, mime]);
}

export function ViewerLoading() {
	const t = useT();
	return (
		<div className="flex items-center gap-2 p-4" role="status">
			<Spinner size="sm" />
			<span className="text-omp-sm text-(--omp-dim)">{t("filesPanel.reading")}</span>
		</div>
	);
}

export function ViewerFailure({ failure }: { failure: InlineFailure }) {
	return (
		<div className="p-4 text-omp-sm text-(--omp-error)" role="alert">
			{failure.message}
			<ErrorDetail className="mt-1" error={failure.cause} />
		</div>
	);
}

/** A file this view can't show: too large, or a format with no in-app viewer. */
export function ViewerFallbackCard({ path, title, detail }: { path: string; title: string; detail?: ReactNode }) {
	const t = useT();
	return (
		<div className="m-3 rounded-md border border-(--omp-border-muted) p-4" data-viewer-fallback>
			<p className="text-omp-sm text-(--omp-text)">{title}</p>
			{detail && <p className="mt-1 text-omp-xs text-(--omp-dim)">{detail}</p>}
			<PathLink
				path={path}
				className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-(--omp-border-muted) px-2 py-1 text-omp-xs text-(--omp-text) hover:bg-(--omp-bg-tertiary)"
			>
				<ExternalLinkIcon size={12} />
				<span>{t("fileViewer.openDefault")}</span>
			</PathLink>
		</div>
	);
}

export function ViewerTooLarge({ path, size }: { path: string; size: number }) {
	const t = useT();
	return (
		<ViewerFallbackCard
			path={path}
			title={t("fileViewer.tooLarge", { size: formatBytes(size) })}
			detail={t("fileViewer.tooLargeDetail")}
		/>
	);
}

/** Shown under a text view read as a prefix; offers the rest up to main's cap. */
export function TruncatedNote({
	shownBytes,
	size,
	canLoadMore,
	loadingMore,
	onLoadMore,
}: {
	shownBytes: number;
	size: number;
	canLoadMore: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
}) {
	const t = useT();
	return (
		<div
			className="flex flex-wrap items-center gap-2 border-t border-(--omp-border-muted) px-3 py-2 text-omp-xs text-(--omp-dim)"
			data-truncated-note
		>
			<span>{t("fileViewer.truncated", { shown: formatBytes(shownBytes), size: formatBytes(size) })}</span>
			{canLoadMore && (
				<Button loading={loadingMore} onClick={onLoadMore} size="sm" variant="ghost">
					{t("fileViewer.loadMore")}
				</Button>
			)}
		</div>
	);
}

/** One row of view controls above the content (mode switch, wrap, zoom). */
export function ViewerToolbar({ children, label }: { children: ReactNode; label: string }) {
	return (
		<div
			aria-label={label}
			className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-(--omp-border-muted) px-2 py-1"
			role="toolbar"
		>
			{children}
		</div>
	);
}

/** Zoom levels relative to fitting the panel width (PDF pages, Word pages). */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
export const ZOOM_FIT_INDEX = ZOOM_STEPS.indexOf(1);

/** Zoom out, the current percentage (click: back to fit), zoom in. */
export function ZoomControls({ index, onChange }: { index: number; onChange: (index: number) => void }) {
	const t = useT();
	const zoom = ZOOM_STEPS[index] ?? 1;
	return (
		<>
			<IconButton
				disabled={index === 0}
				icon={<ZoomOut />}
				label={t("fileViewer.zoomOut")}
				onClick={() => onChange(Math.max(0, index - 1))}
				size="sm"
			/>
			<Button
				aria-label={t("fileViewer.zoomFit")}
				className="min-w-14 tabular-nums"
				onClick={() => onChange(ZOOM_FIT_INDEX)}
				size="sm"
				variant="ghost"
			>
				{`${Math.round(zoom * 100)}%`}
			</Button>
			<IconButton
				disabled={index === ZOOM_STEPS.length - 1}
				icon={<ZoomIn />}
				label={t("fileViewer.zoomIn")}
				onClick={() => onChange(Math.min(ZOOM_STEPS.length - 1, index + 1))}
				size="sm"
			/>
		</>
	);
}
