/**
 * Word, Excel and PowerPoint previews (.docx, .xlsx, .pptx). Each reads the
 * whole file through `fs.readBinary` (so a paired host's tab reads on that
 * host) and parses it in a lazily imported chunk: docx-preview for Word, the
 * JSZip-based readers in xlsx.ts and pptx.ts for the others. Nothing a
 * document references outside its own package is fetched.
 */
import { ChevronRight } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { Tabs } from "../../common";
import type { DocxLayout } from "./docx-runtime";
import type { Slide } from "./pptx";
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
import type { SheetGrid, WorkbookFile } from "./xlsx";

interface OfficeViewProps {
	path: string;
	tabId: string | undefined;
}

/** The whole-file read and its end states; `children` gets the bytes. */
function OfficeFrame({ path, tabId, children }: OfficeViewProps & { children: (data: Uint8Array) => ReactNode }) {
	const state = useBinaryFile(path, tabId);
	useReportFileInfo(
		state.status === "ready" || state.status === "tooLarge" ? state.size : null,
		state.status === "ready" || state.status === "tooLarge" ? state.mime : undefined,
	);
	if (state.status === "loading") return <ViewerLoading />;
	if (state.status === "error") return <ViewerFailure failure={state.failure} />;
	if (state.status === "tooLarge") return <ViewerTooLarge path={path} size={state.size} />;
	return children(state.data);
}

type Parsed<T> = { status: "loading" } | { status: "error"; failure: InlineFailure } | { status: "ready"; value: T };

/** Runs an async parser over `source`; `parse` must be stable (module scope, or a stable object's own function). */
function useParsed<S, T>(source: S, parse: (source: S) => Promise<T>): Parsed<T> {
	const t = useT();
	const [state, setState] = useState<Parsed<T>>({ status: "loading" });
	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		parse(source).then(
			value => {
				if (!cancelled) setState({ status: "ready", value });
			},
			(error: unknown) => {
				if (!cancelled) setState({ status: "error", failure: inlineFailure(error, t("fileViewer.officeFailed")) });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [source, parse, t]);
	return state;
}

/** Tracks an element's content width (0 until measured). */
function useContentWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(entries => {
			const next = entries[0]?.contentRect.width;
			if (next) setWidth(next);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

// ---------------------------------------------------------------------------
// Word

/** Padding docx-preview's page column gets inside the shadow root (px, each side). */
const DOCX_GUTTER = 12;

/**
 * Overrides for docx-preview's frame inside the shadow root: no grey backdrop
 * (the panel is the backdrop), tighter gutters, and pages that stay centered
 * without clipping their left edge when zoomed past the panel width.
 */
const DOCX_PAGES_CSS = `
.docx-wrapper { background: transparent; padding: ${DOCX_GUTTER}px; align-items: safe center; }
.docx-wrapper > section.docx { margin-bottom: ${DOCX_GUTTER}px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35); }
a[title] { cursor: help; }
`;

/**
 * Reading layout: one sheet of paper as wide as the panel. The document's page
 * margins (an inch or more) would eat a narrow panel, so a small fixed inset
 * replaces them; the inline padding docx-preview sets needs `!important`.
 */
const DOCX_REFLOW_CSS = `
.docx-wrapper { background: transparent; padding: 0; display: block; }
.docx-wrapper > section.docx { box-sizing: border-box; width: auto !important; min-height: 0 !important; margin: 0; padding: 16px 20px !important; }
a[title] { cursor: help; }
`;

type DocxPhase =
	| { status: "rendering" }
	| { status: "error"; failure: InlineFailure }
	| { status: "ready"; pageWidth: number };

function DocxDocument({ data }: { data: Uint8Array }) {
	const t = useT();
	const scrollRef = useRef<HTMLDivElement>(null);
	const hostRef = useRef<HTMLDivElement>(null);
	const [phase, setPhase] = useState<DocxPhase>({ status: "rendering" });
	// Reading first: a fitted page in a ~380px panel shrinks body text to a few pixels.
	const [layout, setLayout] = useState<DocxLayout>("reflow");
	const [zoomIndex, setZoomIndex] = useState<number>(ZOOM_FIT_INDEX);
	const containerWidth = useContentWidth(scrollRef);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		// Shadow root: the document's generated stylesheet stays scoped to it.
		const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
		const styles = document.createElement("div");
		const frame = document.createElement("style");
		frame.textContent = layout === "reflow" ? DOCX_REFLOW_CSS : DOCX_PAGES_CSS;
		const body = document.createElement("div");
		shadow.replaceChildren(styles, frame, body);
		let cancelled = false;
		setPhase({ status: "rendering" });
		void (async () => {
			try {
				// Lazy chunk: docx-preview and JSZip load only when a Word document opens.
				const { renderDocx } = await import("./docx-runtime");
				if (cancelled) return;
				await renderDocx(data, body, styles, layout);
				if (cancelled) return;
				const pages = [...body.querySelectorAll<HTMLElement>("section.docx")];
				setPhase({ status: "ready", pageWidth: Math.max(0, ...pages.map(page => page.offsetWidth)) });
			} catch (error) {
				if (!cancelled) setPhase({ status: "error", failure: inlineFailure(error, t("fileViewer.officeFailed")) });
			}
		})();
		return () => {
			cancelled = true;
			shadow.replaceChildren();
		};
	}, [data, layout, t]);

	const paged = layout === "pages";
	const naturalWidth = paged && phase.status === "ready" ? phase.pageWidth + DOCX_GUTTER * 2 : 0;
	const fitScale = naturalWidth > 0 && containerWidth > 0 ? containerWidth / naturalWidth : 1;
	const scale = paged ? fitScale * (ZOOM_STEPS[zoomIndex] ?? 1) : 1;

	return (
		<div className="flex h-full min-h-0 flex-col" data-docx-layout={layout} data-viewer="docx">
			<ViewerToolbar label={t("fileViewer.toolbar")}>
				<Tabs
					activeId={layout}
					ariaLabel={t("fileViewer.docxLayout")}
					compact
					onChange={id => setLayout(id === "pages" ? "pages" : "reflow")}
					tabs={[
						{ id: "reflow", label: t("fileViewer.docxReflow") },
						{ id: "pages", label: t("fileViewer.docxPages") },
					]}
					variant="segmented"
				/>
				{paged && <ZoomControls index={zoomIndex} onChange={setZoomIndex} />}
			</ViewerToolbar>
			<div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
				{phase.status === "rendering" && <ViewerLoading />}
				{phase.status === "error" && <ViewerFailure failure={phase.failure} />}
				<div
					aria-label={t("fileViewer.docxContent")}
					data-docx-host
					hidden={phase.status === "error"}
					ref={hostRef}
					role="document"
					style={{ zoom: scale }}
				/>
			</div>
		</div>
	);
}

export function DocxView({ path, tabId }: OfficeViewProps) {
	return (
		<OfficeFrame path={path} tabId={tabId}>
			{data => <DocxDocument data={data} />}
		</OfficeFrame>
	);
}

// ---------------------------------------------------------------------------
// Excel

// Dynamic on purpose: each reader (and JSZip) is its own lazy chunk, loaded only when such a file opens.
const loadWorkbook = async (data: Uint8Array): Promise<WorkbookFile> => (await import("./xlsx")).openWorkbook(data);

/** 1 → A, 27 → AA (here, not in xlsx.ts: a static import of that would make JSZip eager). */
function columnLabel(column: number): string {
	let name = "";
	for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
	return name;
}

function SheetTable({ grid }: { grid: SheetGrid }) {
	const t = useT();
	if (grid.rows.length === 0) {
		return (
			<p className="p-4 text-sc-sm text-(--sc-text-muted)" data-sheet-empty>
				{t("fileViewer.sheetEmpty")}
			</p>
		);
	}
	return (
		<>
			<table className="min-w-full border-separate border-spacing-0 text-sc-sm" data-sheet-grid>
				<thead className="sticky top-0 z-(--sc-z-sticky)">
					<tr>
						<th className="sticky left-0 border-b border-(--sc-border-subtle) bg-(--sc-surface-2) px-2 py-1" />
						{Array.from({ length: grid.columns }, (_, c) => (
							<th
								className="border-b border-l border-(--sc-border-subtle) bg-(--sc-surface-2) px-2 py-1 text-center font-normal text-(--sc-text-muted)"
								key={c}
								scope="col"
							>
								{columnLabel(c + 1)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{grid.rows.map((row, r) => (
						<tr key={r}>
							<th
								className="sticky left-0 border-b border-(--sc-divider) bg-(--sc-surface-2) px-2 py-0.5 text-right font-normal text-(--sc-text-muted) tabular-nums"
								scope="row"
							>
								{r + 1}
							</th>
							{row.map((cell, c) => (
								<td
									className={cx(
										"max-w-96 truncate border-b border-l border-(--sc-divider) px-2 py-0.5 whitespace-pre text-(--sc-text)",
										cell.numeric && "text-right tabular-nums",
									)}
									key={c}
									title={cell.text}
								>
									{cell.text}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{(grid.clippedRows || grid.clippedColumns) && (
				<p className="px-3 py-2 text-sc-xs text-(--sc-text-muted)" data-table-clipped>
					{[
						grid.clippedRows ? t("fileViewer.tableClipped", { rows: grid.rows.length }) : null,
						grid.clippedColumns ? t("fileViewer.sheetColumnsClipped", { columns: grid.columns }) : null,
					]
						.filter(note => note !== null)
						.join(" ")}
				</p>
			)}
		</>
	);
}

function WorkbookView({ workbook }: { workbook: WorkbookFile }) {
	const t = useT();
	const [active, setActive] = useState(0);
	const sheet = useParsed(active, workbook.readSheet);
	const current = workbook.sheets[active];

	if (workbook.sheets.length === 0) {
		return <p className="p-4 text-sc-sm text-(--sc-text-muted)">{t("fileViewer.workbookEmpty")}</p>;
	}
	const sheetLabel = (index: number) =>
		workbook.sheets[index]?.name || t("fileViewer.sheetUntitled", { number: index + 1 });
	return (
		<div className="flex h-full min-h-0 flex-col" data-viewer="xlsx">
			<div className="shrink-0 overflow-x-auto px-2">
				<Tabs
					activeId={String(active)}
					ariaLabel={t("fileViewer.sheets")}
					compact
					onChange={id => setActive(Number(id))}
					tabs={workbook.sheets.map((_, index) => ({ id: String(index), label: sheetLabel(index) }))}
				/>
			</div>
			<div aria-label={sheetLabel(active)} className="min-h-0 flex-1 overflow-auto" role="tabpanel">
				{current?.path === null ? (
					<p className="p-4 text-sc-sm text-(--sc-text-muted)">{t("fileViewer.sheetChart")}</p>
				) : sheet.status === "loading" ? (
					<ViewerLoading />
				) : sheet.status === "error" ? (
					<ViewerFailure failure={sheet.failure} />
				) : (
					<SheetTable grid={sheet.value} />
				)}
			</div>
		</div>
	);
}

function WorkbookLoader({ data }: { data: Uint8Array }) {
	const state = useParsed(data, loadWorkbook);
	if (state.status === "loading") return <ViewerLoading />;
	if (state.status === "error") return <ViewerFailure failure={state.failure} />;
	return <WorkbookView workbook={state.value} />;
}

export function XlsxView({ path, tabId }: OfficeViewProps) {
	return (
		<OfficeFrame path={path} tabId={tabId}>
			{data => <WorkbookLoader data={data} />}
		</OfficeFrame>
	);
}

// ---------------------------------------------------------------------------
// PowerPoint

// Dynamic on purpose, like loadWorkbook.
const loadSlides = async (data: Uint8Array): Promise<Slide[]> => (await import("./pptx")).readPresentation(data);

function SlideImages({ slide }: { slide: Slide }) {
	const t = useT();
	const [urls, setUrls] = useState<string[]>([]);
	useEffect(() => {
		// Bytes from the package as blob: URLs (allowed by img-src); nothing is fetched.
		const next = slide.images.map(image =>
			URL.createObjectURL(new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mime })),
		);
		setUrls(next);
		return () => {
			for (const url of next) URL.revokeObjectURL(url);
			setUrls([]);
		};
	}, [slide]);
	if (urls.length === 0) return null;
	return (
		<div className="mt-3 flex flex-wrap gap-2">
			{urls.map((url, index) => (
				<img
					alt={t("fileViewer.slideImage", { slide: slide.number, index: index + 1 })}
					className="max-h-64 max-w-full rounded-(--sc-radius-sm) border border-(--sc-border-subtle) object-contain"
					data-slide-image
					key={url}
					src={url}
				/>
			))}
		</div>
	);
}

function SlideCard({ slide }: { slide: Slide }) {
	const t = useT();
	const label = t("fileViewer.slide", { number: slide.number });
	const empty = slide.title === null && slide.paragraphs.length === 0 && slide.images.length === 0;
	return (
		<li>
			<article
				aria-label={label}
				className="rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-3"
				data-slide={slide.number}
			>
				<p className="flex items-center gap-2 text-sc-xs text-(--sc-text-muted)">
					<span className="tabular-nums">{label}</span>
					{slide.hidden && (
						<span className="rounded-(--sc-radius-sm) border border-(--sc-border-subtle) px-1">
							{t("fileViewer.slideHidden")}
						</span>
					)}
				</p>
				{slide.title !== null && (
					<h3 className="mt-1 text-sc-md font-semibold whitespace-pre-wrap break-words text-(--sc-text)">
						{slide.title}
					</h3>
				)}
				{slide.paragraphs.length > 0 && (
					<div className="mt-2 flex flex-col gap-1 text-sc-sm break-words text-(--sc-text)">
						{slide.paragraphs.map((paragraph, index) => (
							<p
								className="whitespace-pre-wrap"
								key={index}
								style={paragraph.level > 0 ? { paddingInlineStart: `${paragraph.level * 1.25}rem` } : undefined}
							>
								{paragraph.text}
							</p>
						))}
					</div>
				)}
				{empty && <p className="mt-1 text-sc-sm text-(--sc-text-muted)">{t("fileViewer.slideEmpty")}</p>}
				<SlideImages slide={slide} />
				{slide.skippedImages > 0 && (
					<p className="mt-2 text-sc-xs text-(--sc-text-muted)">
						{t("fileViewer.slideImagesSkipped", { count: slide.skippedImages })}
					</p>
				)}
				{slide.notes.length > 0 && (
					<details className="group/notes mt-3 border-t border-(--sc-divider) pt-2" data-slide-notes>
						<summary className="flex min-h-(--sc-control-sm) cursor-pointer list-none items-center gap-1 rounded-(--sc-radius-sm) text-sc-xs text-(--sc-text-muted) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) [&::-webkit-details-marker]:hidden">
							<ChevronRight aria-hidden className="size-(--sc-icon-sm) group-open/notes:rotate-90" />
							{t("fileViewer.slideNotes")}
						</summary>
						<div className="mt-1 flex flex-col gap-1 text-sc-sm break-words text-(--sc-text)">
							{slide.notes.map((note, index) => (
								<p className="whitespace-pre-wrap" key={index}>
									{note}
								</p>
							))}
						</div>
					</details>
				)}
			</article>
		</li>
	);
}

function SlidesLoader({ data }: { data: Uint8Array }) {
	const t = useT();
	const state = useParsed(data, loadSlides);
	if (state.status === "loading") return <ViewerLoading />;
	if (state.status === "error") return <ViewerFailure failure={state.failure} />;
	const slides = state.value;
	return (
		<div className="flex h-full min-h-0 flex-col" data-viewer="pptx">
			<ViewerToolbar label={t("fileViewer.toolbar")}>
				<span className="ps-1 text-sc-xs text-(--sc-text-muted)" data-slides-simplified>
					{t("fileViewer.slidesSimplified")}
				</span>
				<span className="ms-auto pe-1 text-sc-xs text-(--sc-text-muted) tabular-nums">
					{t("fileViewer.slideCount", { count: slides.length })}
				</span>
			</ViewerToolbar>
			<div className="min-h-0 flex-1 overflow-auto p-3">
				{slides.length === 0 ? (
					<p className="text-omp-sm text-(--omp-dim)">{t("fileViewer.presentationEmpty")}</p>
				) : (
					<ol className="flex flex-col gap-3">
						{slides.map(slide => (
							<SlideCard key={slide.number} slide={slide} />
						))}
					</ol>
				)}
			</div>
		</div>
	);
}

export function PptxView({ path, tabId }: OfficeViewProps) {
	return (
		<OfficeFrame path={path} tabId={tabId}>
			{data => <SlidesLoader data={data} />}
		</OfficeFrame>
	);
}
