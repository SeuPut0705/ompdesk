/**
 * Images through `fs.readImage` (sniffed data URL) shown with ZoomableImage;
 * audio and video through `fs.readBinary` as a blob URL (CSP `media-src
 * blob:`), revoked when the view unmounts or the file changes.
 */
import { useEffect, useState } from "react";
import { ipcErrorCode } from "../../../../shared/ipc-error-codes";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { basename } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { ZoomableImage } from "../../common";
import { useBinaryFile } from "./use-file-read";
import { useReportFileInfo, ViewerFailure, ViewerLoading, ViewerTooLarge } from "./viewer-chrome";

interface MediaViewProps {
	path: string;
	tabId: string | undefined;
}

type ImageState =
	| { status: "loading" }
	| { status: "error"; failure: InlineFailure }
	| { status: "tooLarge"; size: number }
	| { status: "ready"; src: string; mime: string; size: number };

export function ImageView({ path, tabId }: MediaViewProps) {
	const t = useT();
	const [state, setState] = useState<ImageState>({ status: "loading" });
	const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		setDimensions(null);
		void (async () => {
			try {
				const result = tabId ? await window.omp.fs.readImage(path, tabId) : await window.omp.fs.readImage(path);
				if (cancelled) return;
				if (result.ok && result.dataUrl) {
					setState({ status: "ready", src: result.dataUrl, mime: result.mime ?? "", size: result.size });
				} else if (ipcErrorCode(result) === "image_too_large") {
					setState({ status: "tooLarge", size: result.size });
				} else {
					setState({ status: "error", failure: inlineFailure(result, t("filesPanel.readFailed")) });
				}
			} catch (error) {
				if (!cancelled) setState({ status: "error", failure: inlineFailure(error, t("filesPanel.readFailed")) });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path, tabId, t]);

	useReportFileInfo(
		state.status === "ready" || state.status === "tooLarge" ? state.size : null,
		state.status === "ready" ? state.mime : undefined,
	);
	if (state.status === "loading") return <ViewerLoading />;
	if (state.status === "error") return <ViewerFailure failure={state.failure} />;
	if (state.status === "tooLarge") return <ViewerTooLarge path={path} size={state.size} />;
	return (
		<div className="h-full overflow-auto p-3" data-viewer="image">
			<ZoomableImage
				alt={basename(path)}
				className="h-auto max-w-full"
				onLoad={event =>
					setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
				}
				src={state.src}
			/>
			{dimensions && (
				<p className="mt-2 text-sc-xs text-(--sc-text-muted) tabular-nums" data-image-info>
					{t("fileViewer.imageInfo", { width: dimensions.width, height: dimensions.height })}
				</p>
			)}
		</div>
	);
}

export function AvView({ path, tabId, kind }: MediaViewProps & { kind: "audio" | "video" }) {
	const state = useBinaryFile(path, tabId);
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		if (state.status !== "ready") return;
		// IPC structured clone always backs the bytes with a plain ArrayBuffer, never a shared one.
		const bytes = state.data as Uint8Array<ArrayBuffer>;
		const next = URL.createObjectURL(new Blob([bytes], { type: state.mime || `${kind}/*` }));
		setUrl(next);
		return () => {
			URL.revokeObjectURL(next);
			setUrl(null);
		};
	}, [state, kind]);
	useReportFileInfo(
		state.status === "ready" || state.status === "tooLarge" ? state.size : null,
		state.status === "ready" || state.status === "tooLarge" ? state.mime : undefined,
	);
	if (state.status === "loading") return <ViewerLoading />;
	if (state.status === "error") return <ViewerFailure failure={state.failure} />;
	if (state.status === "tooLarge") return <ViewerTooLarge path={path} size={state.size} />;
	return (
		<div className="flex h-full items-start justify-center overflow-auto p-3" data-viewer={kind}>
			{kind === "audio" ? (
				<audio className="w-full" controls src={url ?? undefined} />
			) : (
				<video className="max-h-full max-w-full" controls src={url ?? undefined} />
			)}
		</div>
	);
}
