/**
 * A file the conversation names, drawn so a person can see what it is and reach it: under a reply
 * (ReplyFiles, a markdown embed) and under a prompt that attached it (MessageBubble), read the way
 * the Files viewer does for the tab it belongs to (a paired host's tab reads on that host), and
 * only once it nears the screen.
 *
 * - A file with something to look at is a card: its picture, a PDF's first page, a page drawn in an
 *   empty sandbox, a spreadsheet's or CSV's first rows, a presentation's first slide title; under
 *   it the name, "type · rows/slides · size", and its actions.
 * - Any other file (a Word document, an archive, a program, a text file, a folder) is a row: a tile
 *   with its type, the name and meta, and the same actions.
 * - The actions are file-actions.tsx's: one button for the place it lives (show in Finder/Explorer
 *   on this computer, save here from a paired host or to the phone) and a ⋯ menu with the rest; a
 *   right click opens the same menu. A click on the card previews it (the Files viewer; a picture
 *   zooms).
 * - A draft's `@path` mention (composer, `compact`) is a one-line chip with the file's name that
 *   reads no preview.
 * A file that is gone reads "Deleted".
 */

import {
	Archive,
	File,
	FileBadge,
	FileCode,
	FileImage,
	FileSpreadsheet,
	FileText,
	Folder,
	type LucideIcon,
	Presentation,
	X,
} from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { basename, cx, formatBytes, uiLocale } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useLinkMenu } from "../../../lib/link-menu";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { IconButton } from "../../common/IconButton";
import { fileExtension, fileIconKind, viewerKind } from "../../panels/viewers/file-kind";
import { parseDelimited } from "../../panels/viewers/parse";
import { FileActions, previewFile } from "./file-actions";
import { ToolImage } from "./ToolImage";
import { useNearViewport } from "./ToolMedia";

export type FileCardKind =
	| "folder"
	| "image"
	| "pdf"
	| "html"
	| "word"
	| "spreadsheet"
	| "presentation"
	| "csv"
	| "office"
	| "archive"
	| "text"
	| "file";

/** What a card draws above its name: read from the file once it nears the screen. */
type PreviewSource = "image" | "pdf" | "page" | "sheet" | "slides" | "csv";

interface KindSpec {
	icon: LucideIcon;
	/** Null: nothing to draw, so the file is a row. */
	preview: PreviewSource | null;
}

/** Every kind's icon and what its card draws: the one table the card's shape, preview and tile read. */
const KINDS: Record<FileCardKind, KindSpec> = {
	folder: { icon: Folder, preview: null },
	image: { icon: FileImage, preview: "image" },
	pdf: { icon: FileBadge, preview: "pdf" },
	html: { icon: FileCode, preview: "page" },
	word: { icon: FileText, preview: null },
	spreadsheet: { icon: FileSpreadsheet, preview: "sheet" },
	presentation: { icon: Presentation, preview: "slides" },
	csv: { icon: FileSpreadsheet, preview: "csv" },
	office: { icon: FileText, preview: null },
	archive: { icon: Archive, preview: null },
	text: { icon: FileText, preview: null },
	file: { icon: File, preview: null },
};

/** The card's type by the Files viewer's extension table. */
export function fileCardKind(path: string, directory = false): FileCardKind {
	if (directory) return "folder";
	switch (viewerKind(path)) {
		case "image":
			return "image";
		case "pdf":
			return "pdf";
		case "html":
			return "html";
		case "docx":
			return "word";
		case "xlsx":
			return "spreadsheet";
		case "pptx":
			return "presentation";
		case "csv":
			return "csv";
		case "office":
			return "office";
		case "binary":
			return fileIconKind(path) === "archive" ? "archive" : "file";
		case "audio":
		case "video":
			return "file";
		default:
			return "text";
	}
}

/** A card (it has something to draw) or a row (it has not). */
export function fileCardShape(kind: FileCardKind): "card" | "row" {
	return KINDS[kind].preview ? "card" : "row";
}

/** Files past this stay a card without a preview (the chat's PDF thumbnail ceiling). */
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** Text read for a CSV or page preview and a CSV's row count (the Files viewer's first read). */
const TEXT_PREVIEW_BYTES = 200_000;
const PREVIEW_ROWS = 4;
const PREVIEW_COLUMNS = 4;
/** CSS width the PDF's first page is drawn at (the card's width, sharp on a 2x screen). */
const PDF_PAGE_WIDTH = 240;

/** What the meta line counts: `count` of `unit` (`+` when the file holds more than was read). */
interface Count {
	unit: "slides" | "rows" | "sheets";
	count: number;
	more?: boolean;
}

type CardState =
	| { status: "idle" | "loading" }
	| { status: "missing" }
	| { status: "failed" }
	| { status: "ready"; kind: FileCardKind; size: number };

function lineCount(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

interface PreviewProps {
	path: string;
	name: string;
	tabId: string | undefined;
	onCount: (count: Count) => void;
	/** The file cannot be drawn: the card shows its tile instead. */
	onFailed: () => void;
}

function readBinaryFor(path: string, tabId: string | undefined) {
	return tabId ? window.omp.fs.readBinary(path, undefined, tabId) : window.omp.fs.readBinary(path);
}

function readTextFor(path: string, tabId: string | undefined) {
	return tabId ? window.omp.fs.read(path, TEXT_PREVIEW_BYTES, tabId) : window.omp.fs.read(path, TEXT_PREVIEW_BYTES);
}

/** A load that runs once per path and tab, dropping its answer when the card left. */
function useLoad(
	run: (live: () => boolean) => Promise<void>,
	onFailed: () => void,
	path: string,
	tabId: string | undefined,
) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: the load and its failure are callbacks of the same file
	useEffect(() => {
		let alive = true;
		run(() => alive).catch(() => alive && onFailed());
		return () => {
			alive = false;
		};
	}, [path, tabId]);
}

function ImagePreview({ path, name, tabId, onFailed }: PreviewProps) {
	const [src, setSrc] = useState<string | null>(null);
	useLoad(
		async live => {
			const result = tabId ? await window.omp.fs.readImage(path, tabId) : await window.omp.fs.readImage(path);
			if (!live()) return;
			if (result.ok && result.dataUrl) setSrc(result.dataUrl);
			else onFailed();
		},
		onFailed,
		path,
		tabId,
	);
	if (!src) return null;
	return (
		<ToolImage
			className="omp-file-card-image"
			decoding="async"
			label={name}
			path={path}
			src={src}
			thumbClassName="omp-file-card-zoom"
		/>
	);
}

function PdfPreview({ path, tabId, onFailed }: PreviewProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [drawn, setDrawn] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: onFailed is a notification
	useEffect(() => {
		let alive = true;
		let destroy: (() => Promise<void>) | undefined;
		void (async () => {
			try {
				const file = await readBinaryFor(path, tabId);
				if (!file.ok) throw file;
				// Lazy chunk: pdf.js loads only when a PDF preview is on screen, like the Files viewer's.
				const { getDocument } = await import("../../panels/viewers/pdf-runtime");
				if (!alive) return;
				const task = getDocument({ data: file.data });
				destroy = () => task.destroy();
				const doc = await task.promise;
				const page = await doc.getPage(1);
				const canvas = canvasRef.current;
				if (!alive || !canvas) return;
				const natural = page.getViewport({ scale: 1 });
				const viewport = page.getViewport({
					scale: (PDF_PAGE_WIDTH / natural.width) * (window.devicePixelRatio || 1),
				});
				canvas.width = Math.floor(viewport.width);
				canvas.height = Math.floor(viewport.height);
				await page.render({ canvas, viewport }).promise;
				if (alive) setDrawn(true);
			} catch {
				if (alive) onFailed();
			}
		})();
		return () => {
			alive = false;
			void destroy?.();
		};
	}, [path, tabId]);
	return <canvas aria-hidden className="omp-file-card-page" hidden={!drawn} ref={canvasRef} />;
}

/**
 * A page drawn in an empty-sandbox frame — no scripts, same-origin, forms, popups or navigation;
 * as srcdoc it inherits this window's CSP, so it fetches nothing off the app (the Files viewer's
 * own HTML isolation) — at a desktop width, scaled down to the card, never taking a click.
 */
function PagePreview({ path, name, tabId, onFailed }: PreviewProps) {
	const t = useT();
	const [content, setContent] = useState<string | null>(null);
	useLoad(
		async live => {
			const result = await readTextFor(path, tabId);
			if (!live()) return;
			if (result.ok && typeof result.content === "string" && !result.binary) setContent(result.content);
			else onFailed();
		},
		onFailed,
		path,
		tabId,
	);
	if (content === null) return null;
	return (
		<span aria-hidden className="omp-file-card-frame-box" inert>
			<iframe
				// White canvas like a browser tab (and the Files viewer's frame): pages assume it.
				className="omp-file-card-frame bg-white"
				data-html-rendered
				sandbox=""
				srcDoc={content}
				tabIndex={-1}
				title={t("chat.media.htmlFrame", { name })}
			/>
		</span>
	);
}

function TablePreview({ rows }: { rows: string[][] }) {
	return (
		<table aria-hidden className="omp-file-card-table">
			<tbody>
				{rows.map((row, rowIndex) => (
					<tr key={rowIndex}>
						{row.map((cell, cellIndex) => (
							<td key={cellIndex}>{cell}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

function SheetPreview({ path, tabId, onCount, onFailed }: PreviewProps) {
	const [rows, setRows] = useState<string[][] | null>(null);
	useLoad(
		async live => {
			const file = await readBinaryFor(path, tabId);
			if (!file.ok) throw file;
			// Lazy like OfficeViews' loadWorkbook: the OOXML reader loads with the first workbook.
			const { openWorkbook } = await import("../../panels/viewers/xlsx");
			const workbook = await openWorkbook(file.data);
			const first = workbook.sheets.findIndex(sheet => sheet.path !== null);
			if (first < 0) {
				if (live()) onCount({ unit: "sheets", count: workbook.sheets.length });
				throw new Error("no sheet");
			}
			const grid = await workbook.readSheet(first);
			if (!live()) return;
			setRows(grid.rows.slice(0, PREVIEW_ROWS).map(row => row.slice(0, PREVIEW_COLUMNS).map(cell => cell.text)));
			onCount({ unit: "rows", count: grid.rows.length, more: grid.clippedRows });
		},
		onFailed,
		path,
		tabId,
	);
	return rows ? <TablePreview rows={rows} /> : null;
}

function CsvPreview({ path, tabId, onCount, onFailed }: PreviewProps) {
	const [rows, setRows] = useState<string[][] | null>(null);
	useLoad(
		async live => {
			const file = await readTextFor(path, tabId);
			if (!live()) return;
			if (!file.ok || file.binary) throw file;
			const table = parseDelimited(file.content, fileExtension(path) === "tsv" ? "\t" : ",", PREVIEW_ROWS);
			setRows(table.rows.map(row => row.slice(0, PREVIEW_COLUMNS)));
			if (!file.truncated) onCount({ unit: "rows", count: lineCount(file.content) });
		},
		onFailed,
		path,
		tabId,
	);
	return rows ? <TablePreview rows={rows} /> : null;
}

function SlidesPreview({ path, tabId, onCount, onFailed }: PreviewProps) {
	const [title, setTitle] = useState<string | null>(null);
	useLoad(
		async live => {
			const file = await readBinaryFor(path, tabId);
			if (!file.ok) throw file;
			// Lazy like OfficeViews' loadSlides: the presentation reader loads with the first deck.
			const { readPresentation } = await import("../../panels/viewers/pptx");
			const slides = await readPresentation(file.data);
			if (!live()) return;
			onCount({ unit: "slides", count: slides.length });
			const text = slides[0]?.title ?? slides[0]?.paragraphs[0]?.text ?? "";
			if (text) setTitle(text);
			else onFailed();
		},
		onFailed,
		path,
		tabId,
	);
	return title ? <span className="omp-file-card-slide">{title}</span> : null;
}

const PREVIEWS: Record<PreviewSource, (props: PreviewProps) => ReturnType<typeof ImagePreview>> = {
	image: ImagePreview,
	pdf: PdfPreview,
	page: PagePreview,
	sheet: SheetPreview,
	slides: SlidesPreview,
	csv: CsvPreview,
};

/** Kinds named by their own extension ("ZIP", "MD"): one word for many formats would say less. */
const BY_EXTENSION = new Set<FileCardKind>(["archive", "file", "text", "office"]);

function kindLabel(kind: FileCardKind, path: string, t: ReturnType<typeof useT>): string {
	const extension = fileExtension(path);
	return BY_EXTENSION.has(kind) && extension ? extension.toUpperCase() : t(`fileCard.kind.${kind}`);
}

/** The file's type as a tile (the meta line names it in words). */
function KindTile({ kind }: { kind: FileCardKind }) {
	const Icon = KINDS[kind].icon;
	return (
		<span aria-hidden className="omp-file-card-tile" data-kind={kind}>
			<Icon className="omp-file-card-tile-icon" />
		</span>
	);
}

export interface FileCardProps {
	path: string;
	/** Hide the card while the path does not exist (a draft's `@word` that names no file). */
	hideMissing?: boolean;
	/** A one-line chip with the file's name and no preview (a draft's mention: the composer's strip stays small). */
	compact?: boolean;
	/** Draw it as a row whatever it holds (a prompt's attachments stay small inside the bubble). */
	row?: boolean;
	/** The name to show instead of the file's (a markdown embed's alt text). */
	label?: string;
	/** Compact chip: remove the mention. */
	onRemove?: () => void;
	/** Told once whether the path names a file (a draft's chip strip counts the chips that show). */
	onResolved?: (exists: boolean) => void;
}

export function FileCard({
	path,
	hideMissing = false,
	compact = false,
	row = false,
	label,
	onRemove,
	onResolved,
}: FileCardProps) {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const tabId = runtimeTabId ?? undefined;
	const linkMenu = useLinkMenu(runtimeTabId);
	const ref = useRef<HTMLDivElement>(null);
	const near = useNearViewport(ref);
	const [state, setState] = useState<CardState>({ status: "idle" });
	const [count, setCount] = useState<Count | undefined>(undefined);
	const [previewFailed, setPreviewFailed] = useState(false);

	useEffect(() => {
		if (!near) return;
		let live = true;
		setState({ status: "loading" });
		setCount(undefined);
		setPreviewFailed(false);
		void (async () => {
			try {
				const stat = tabId ? await window.omp.fs.stat(path, tabId) : await window.omp.fs.stat(path);
				if (!live) return;
				if (!stat.ok) {
					setState(stat.code === "file_not_found" ? { status: "missing" } : { status: "failed" });
					return;
				}
				setState({ status: "ready", kind: fileCardKind(path, stat.directory === true), size: stat.size });
			} catch {
				if (live) setState({ status: "failed" });
			}
		})();
		return () => {
			live = false;
		};
	}, [near, path, tabId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the callback is a notification, not an input
	useEffect(() => {
		if (state.status === "ready") onResolved?.(true);
		else if (state.status === "missing") onResolved?.(false);
	}, [state.status]);
	if (hideMissing && state.status === "missing") return null;
	const name = label || basename(path.replace(/[\\/]+$/, "")) || path;
	const kind = state.status === "ready" ? state.kind : fileCardKind(path);
	const dir = kind === "folder";
	const missing = state.status === "missing";
	const meta = missing
		? t("fileCard.deleted")
		: [
				kindLabel(kind, path, t),
				count &&
					t(`fileCard.count.${count.unit}`, {
						count: `${count.count.toLocaleString(uiLocale())}${count.more ? "+" : ""}`,
					}),
				state.status === "ready" && !dir ? formatBytes(state.size) : null,
			]
				.filter(Boolean)
				.join(" · ");
	const open = () => {
		if (!missing) previewFile(path, dir);
	};
	const onContextMenu = (event: MouseEvent<HTMLElement>) => {
		if (missing) return;
		event.preventDefault();
		linkMenu.onContextMenu(event, { kind: "path", path, dir });
	};

	if (compact) {
		const Icon = KINDS[kind].icon;
		// A draft's mention: one 28px chip with the file's name (the type, size and path are its tooltip). The
		// strip's keyboard route (strip-roving.ts) reaches its button; Delete on it removes the mention.
		return (
			<div
				className={cx(
					"relative flex h-7 max-w-64 shrink-0 items-center rounded-(--sc-radius-full) border border-(--sc-border-subtle) text-sc-xs text-(--sc-text-secondary)",
					missing && "text-(--sc-warning)",
				)}
				data-file-card={kind}
				data-state={state.status}
				data-strip-item=""
				ref={ref}
				title={`${path}\n${meta}`}
			>
				<button
					aria-label={t("fileCard.open", { name })}
					className="flex h-full min-w-0 items-center gap-1.5 rounded-(--sc-radius-full) pr-1 pl-2.5 hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:outline-(--sc-accent) disabled:cursor-default"
					data-strip-stop=""
					disabled={missing}
					onClick={open}
					type="button"
				>
					<Icon aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
					<span className="truncate font-mono">{name}</span>
				</button>
				{onRemove && (
					<IconButton
						className="omp-attachment-chip-remove shrink-0"
						data-strip-remove=""
						icon={<X />}
						label={t("fileCard.remove", { name })}
						onClick={onRemove}
						size="sm"
						tabIndex={-1}
					/>
				)}
			</div>
		);
	}

	const spec = KINDS[kind];
	const shape = row ? "row" : fileCardShape(kind);
	const previewSource = spec.preview;
	const canPreview =
		shape === "card" &&
		previewSource !== null &&
		near &&
		state.status === "ready" &&
		state.size <= PREVIEW_MAX_BYTES &&
		!previewFailed;
	const Preview = previewSource ? PREVIEWS[previewSource] : null;
	const actions = <FileActions dir={dir} disabled={missing} name={name} path={path} />;
	const caption = (
		<span className="omp-file-card-caption">
			{/* controls-ok: the omp-file-card-name class draws the name as the card's open control */}
			<button
				aria-label={t(dir ? "fileCard.openFolder" : "fileCard.previewName", { name })}
				className="omp-file-card-name"
				disabled={missing}
				onClick={open}
				type="button"
			>
				{name}
			</button>
			<span className="omp-file-card-meta" data-file-card-meta>
				{meta}
			</span>
		</span>
	);
	return (
		<div
			aria-label={name}
			className="omp-file-card"
			data-file-card={kind}
			data-shape={shape}
			data-state={state.status}
			onContextMenu={onContextMenu}
			ref={ref}
			role="group"
			title={path}
		>
			{shape === "card" ? (
				<span className="omp-file-card-view" data-preview={canPreview ? previewSource : undefined}>
					{/* controls-ok: the whole preview opens the file (its own buttons sit in the caption below) */}
					<button
						aria-label={t("fileCard.previewName", { name })}
						className="omp-file-card-open"
						disabled={missing}
						onClick={open}
						tabIndex={-1}
						type="button"
					>
						<KindTile kind={kind} />
					</button>
					{/* What the file holds covers the tile once it is drawn; a click on it reaches the button below. */}
					{canPreview && Preview ? (
						<span className="omp-file-card-drawn">
							<Preview
								name={name}
								onCount={setCount}
								onFailed={() => setPreviewFailed(true)}
								path={path}
								tabId={tabId}
							/>
						</span>
					) : null}
				</span>
			) : (
				<KindTile kind={kind} />
			)}
			<span className="omp-file-card-foot">
				{caption}
				{actions}
			</span>
			{linkMenu.menu}
		</div>
	);
}
