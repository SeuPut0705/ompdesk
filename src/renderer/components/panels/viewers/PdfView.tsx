/**
 * PDF through pdf.js (lazy chunk, own worker): pages on canvas, each painted
 * only while near the viewport and released when it scrolls far away, so a
 * long document never holds every page bitmap. Zoom is relative to fitting
 * the panel width; above 100% the page scrolls horizontally.
 */

import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { type RefObject, useEffect, useRef, useState } from "react";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { useBinaryFile } from "./use-file-read";
import {
	useReportFileInfo,
	ViewerFailure,
	ViewerLoading,
	ViewerTooLarge,
	ViewerToolbar,
	ZOOM_FIT_INDEX,
	ZOOM_STEPS,
	ZoomControls,
} from "./viewer-chrome";

/** Horizontal breathing room around a fitted page (px). */
const PAGE_GUTTER = 24;
/** Pages within this margin of the viewport paint ahead of the scroll. */
const PRERENDER_MARGIN = "100% 0px";

interface PageSize {
	width: number;
	height: number;
}

export function PdfView({ path, tabId }: { path: string; tabId: string | undefined }) {
	const state = useBinaryFile(path, tabId);
	useReportFileInfo(
		state.status === "ready" || state.status === "tooLarge" ? state.size : null,
		state.status === "ready" || state.status === "tooLarge" ? state.mime : undefined,
	);
	if (state.status === "loading") return <ViewerLoading />;
	if (state.status === "error") return <ViewerFailure failure={state.failure} />;
	if (state.status === "tooLarge") return <ViewerTooLarge path={path} size={state.size} />;
	return <PdfDocumentView data={state.data} />;
}

function PdfDocumentView({ data }: { data: Uint8Array }) {
	const t = useT();
	const scrollRef = useRef<HTMLDivElement>(null);
	const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
	const [firstPage, setFirstPage] = useState<PageSize | null>(null);
	const [failure, setFailure] = useState<InlineFailure | null>(null);
	const [zoomIndex, setZoomIndex] = useState<number>(ZOOM_FIT_INDEX);
	const [containerWidth, setContainerWidth] = useState(0);

	useEffect(() => {
		let cancelled = false;
		let task: PDFDocumentLoadingTask | null = null;
		setDoc(null);
		setFailure(null);
		void (async () => {
			try {
				// Lazy chunk: pdf.js (~1 MB plus its worker) loads only when a PDF opens, like loadHljs.
				const { getDocument } = await import("./pdf-runtime");
				if (cancelled) return;
				task = getDocument({ data });
				const loaded = await task.promise;
				const page = await loaded.getPage(1);
				if (cancelled) return;
				const viewport = page.getViewport({ scale: 1 });
				setFirstPage({ width: viewport.width, height: viewport.height });
				setDoc(loaded);
			} catch (error) {
				if (!cancelled) setFailure(inlineFailure(error, t("fileViewer.pdfFailed")));
			}
		})();
		return () => {
			cancelled = true;
			void task?.destroy();
		};
	}, [data, t]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(entries => {
			const width = entries[0]?.contentRect.width;
			if (width) setContainerWidth(width);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const zoom = ZOOM_STEPS[zoomIndex] ?? 1;
	const fitScale =
		firstPage && containerWidth > PAGE_GUTTER * 2 ? (containerWidth - PAGE_GUTTER * 2) / firstPage.width : 1;
	const scale = fitScale * zoom;

	return (
		<div className="flex h-full min-h-0 flex-col" data-viewer="pdf">
			<ViewerToolbar label={t("fileViewer.toolbar")}>
				<ZoomControls index={zoomIndex} onChange={setZoomIndex} />
				{doc && (
					<span className="ms-auto pe-1 text-sc-xs text-(--sc-text-muted) tabular-nums">
						{t("fileViewer.pdfPages", { count: doc.numPages })}
					</span>
				)}
			</ViewerToolbar>
			<div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
				{failure ? (
					<ViewerFailure failure={failure} />
				) : !doc || !firstPage ? (
					<ViewerLoading />
				) : (
					<div
						className="flex w-max min-w-full flex-col items-center gap-3 py-3"
						style={{ paddingInline: PAGE_GUTTER }}
					>
						{Array.from({ length: doc.numPages }, (_, i) => (
							<PdfPage
								doc={doc}
								estimate={firstPage}
								key={i + 1}
								pageNumber={i + 1}
								root={scrollRef}
								scale={scale}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function PdfPage({
	doc,
	pageNumber,
	scale,
	estimate,
	root,
}: {
	doc: PDFDocumentProxy;
	pageNumber: number;
	scale: number;
	/** Page 1's size, used until this page's own size is known. */
	estimate: PageSize;
	root: RefObject<HTMLDivElement | null>;
}) {
	const t = useT();
	const frameRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [size, setSize] = useState<PageSize | null>(null);
	const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === "undefined");

	useEffect(() => {
		const element = frameRef.current;
		if (!element || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(entries => setNearViewport(entries.some(e => e.isIntersecting)), {
			root: root.current,
			rootMargin: PRERENDER_MARGIN,
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [root]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		if (!nearViewport) {
			// Far from view: drop the bitmap; the frame keeps the page's size.
			canvas.width = 0;
			canvas.height = 0;
			return;
		}
		let cancelled = false;
		let task: RenderTask | null = null;
		void (async () => {
			try {
				const page = await doc.getPage(pageNumber);
				if (cancelled) return;
				const natural = page.getViewport({ scale: 1 });
				setSize({ width: natural.width, height: natural.height });
				const viewport = page.getViewport({ scale: scale * (window.devicePixelRatio || 1) });
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				task = page.render({ canvas, viewport });
				await task.promise;
			} catch {
				// Cancelled by a newer scale or by scrolling away; the next pass repaints.
			}
		})();
		return () => {
			cancelled = true;
			task?.cancel();
		};
	}, [doc, pageNumber, scale, nearViewport]);

	const page = size ?? estimate;
	return (
		<div
			aria-label={t("fileViewer.pdfPage", { page: pageNumber })}
			className="relative shrink-0 bg-white shadow-(--sc-shadow-sm)"
			data-pdf-page={pageNumber}
			ref={frameRef}
			role="img"
			style={{ width: Math.round(page.width * scale), height: Math.round(page.height * scale) }}
		>
			<canvas className="block h-full w-full" ref={canvasRef} />
		</div>
	);
}
