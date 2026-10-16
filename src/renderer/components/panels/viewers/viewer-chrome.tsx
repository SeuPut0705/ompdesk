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
import { useFocusedTabDevice, useHostView } from "../../../stores/remote";
import { Button, IconButton, InlineNotice, Spinner } from "../../common";
import { PathLink } from "../../tools/media/PathLink";

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
	return <Spinner className="p-4" label={t("filesPanel.reading")} size="sm" />;
}

export function ViewerFailure({ failure }: { failure: InlineFailure }) {
	return <InlineNotice className="p-4" detail={failure.cause} live title={failure.message} tone="danger" />;
}

/**
 * A file this view can't show: too large, or a format with no in-app viewer. On a paired host's tab
 * the file is on the host and this computer's default app can't reach it, so no open action is
 * offered: "too large" there means over the link's one-frame read cap (FS_BINARY_REMOTE_MAX_BYTES),
 * so it could not be fetched either, and a local copy of any other file would not save back.
 */
export function ViewerFallbackCard({ path, title, detail }: { path: string; title: string; detail?: ReactNode }) {
	const t = useT();
	const remote = useFocusedTabDevice() !== undefined;
	return (
		<div className="m-3 rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-4" data-viewer-fallback>
			<p className="text-sc-sm break-words text-(--sc-text)">{title}</p>
			{detail && <p className="mt-1 text-sc-xs break-words text-(--sc-text-muted)">{detail}</p>}
			{!remote && (
				<PathLink
					path={path}
					className="mt-3 inline-flex min-h-(--sc-control-sm) items-center gap-1.5 rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-2 py-1 text-sc-xs text-(--sc-text) hover:bg-(--sc-hover) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
				>
					<ExternalLinkIcon className="size-(--sc-icon-sm)" />
					<span>{t("fileViewer.openDefault")}</span>
				</PathLink>
			)}
		</div>
	);
}

export function ViewerTooLarge({ path, size }: { path: string; size: number }) {
	const t = useT();
	const device = useFocusedTabDevice();
	const host = useHostView(device);
	return (
		<ViewerFallbackCard
			path={path}
			title={t("fileViewer.tooLarge", { size: formatBytes(size) })}
			detail={
				device === undefined
					? t("fileViewer.tooLargeDetail")
					: t("fileViewer.tooLargeRemoteDetail", { device: host?.name ?? t("remote.tab.unknownDevice") })
			}
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
			className="flex flex-wrap items-center gap-2 border-t border-(--sc-border-subtle) px-3 py-2 text-sc-xs text-(--sc-text-muted)"
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
			className="flex min-h-(--sc-control-md) shrink-0 flex-wrap items-center gap-1 border-b border-(--sc-divider) px-2 py-1"
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
