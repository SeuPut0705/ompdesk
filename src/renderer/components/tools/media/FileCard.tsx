/**
 * A file the conversation names, two ways. A document a reply refers to (Word,
 * Excel, PowerPoint, CSV, other Office files; ReplyFiles and markdown.tsx) is
 * a card: read the way the Files viewer does, for the tab it belongs to (a
 * paired host's tab reads on that host), and only once it nears the screen —
 * a spreadsheet's or CSV's first rows, a presentation's first slide title —
 * then "type · rows/slides · size". A draft's `@path` mention (composer,
 * `compact`) is a one-line chip with the file's name that reads no preview.
 * A file that is gone reads "Deleted"; a click opens it in the Files viewer,
 * a folder in the Files tree.
 */

import {
	File,
	FileBadge,
	FileImage,
	FileSpreadsheet,
	FileText,
	Folder,
	type LucideIcon,
	Presentation,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { basename, cx, formatBytes, uiLocale } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useUiStore } from "../../../stores/ui";
import { IconButton } from "../../common/IconButton";
import { fileExtension, viewerKind } from "../../panels/viewers/file-kind";
import { parseDelimited } from "../../panels/viewers/parse";
import { useNearViewport } from "./ToolMedia";

export type FileCardKind =
	| "folder"
	| "image"
	| "pdf"
	| "word"
	| "spreadsheet"
	| "presentation"
	| "csv"
	| "office"
	| "text"
	| "file";

/** The card's type by the Files viewer's extension table. */
export function fileCardKind(path: string, directory = false): FileCardKind {
	if (directory) return "folder";
	switch (viewerKind(path)) {
		case "image":
			return "image";
		case "pdf":
			return "pdf";
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
		case "audio":
		case "video":
			return "file";
		default:
			return "text";
	}
}

const ICONS: Record<FileCardKind, LucideIcon> = {
	folder: Folder,
	image: FileImage,
	pdf: FileBadge,
	word: FileText,
	spreadsheet: FileSpreadsheet,
	presentation: Presentation,
	csv: FileSpreadsheet,
	office: FileText,
	text: FileText,
	file: File,
};

/** Files past this stay a card without a preview (the chat's PDF thumbnail ceiling). */
const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** Text read for a CSV preview and its row count (the Files viewer's first read). */
const TEXT_PREVIEW_BYTES = 200_000;
const PREVIEW_ROWS = 4;
const PREVIEW_COLUMNS = 4;

type Preview = { type: "table"; rows: string[][] } | { type: "title"; text: string };

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
	| { status: "ready"; kind: FileCardKind; size: number; preview?: Preview; count?: Count };

function lineCount(text: string): number {
	if (text === "") return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export interface FileCardProps {
	path: string;
	/** Hide the card while the path does not exist (a draft's `@word` that names no file). */
	hideMissing?: boolean;
	/** A one-line chip with the file's name and no preview (a draft's mention: the composer's strip stays small). */
	compact?: boolean;
	/** Compact chip: remove the mention. */
	onRemove?: () => void;
	/** Told once whether the path names a file (a draft's chip strip counts the chips that show). */
	onResolved?: (exists: boolean) => void;
}

export function FileCard({ path, hideMissing = false, compact = false, onRemove, onResolved }: FileCardProps) {
	const t = useT();
	const tabId = useRuntimeTabId() ?? undefined;
	const ref = useRef<HTMLDivElement>(null);
	const near = useNearViewport(ref);
	const [state, setState] = useState<CardState>({ status: "idle" });

	useEffect(() => {
		if (!near) return;
		let live = true;
		setState({ status: "loading" });
		void (async () => {
			try {
				const stat = tabId ? await window.omp.fs.stat(path, tabId) : await window.omp.fs.stat(path);
				if (!live) return;
				if (!stat.ok) {
					setState(stat.code === "file_not_found" ? { status: "missing" } : { status: "failed" });
					return;
				}
				const kind = fileCardKind(path, stat.directory === true);
				const ready = (preview?: Preview, count?: Count) =>
					live && setState({ status: "ready", kind, size: stat.size, preview, count });
				if (kind === "folder" || stat.size > PREVIEW_MAX_BYTES || compact) return ready();
				const readBinary = async () => {
					const file = tabId
						? await window.omp.fs.readBinary(path, undefined, tabId)
						: await window.omp.fs.readBinary(path);
					if (!file.ok) throw file;
					return file.data;
				};
				switch (kind) {
					case "spreadsheet": {
						const data = await readBinary();
						// Lazy like OfficeViews' loadWorkbook: the OOXML reader loads with the first workbook.
						const { openWorkbook } = await import("../../panels/viewers/xlsx");
						const workbook = await openWorkbook(data);
						const first = workbook.sheets.findIndex(sheet => sheet.path !== null);
						if (first < 0) return ready(undefined, { unit: "sheets", count: workbook.sheets.length });
						const grid = await workbook.readSheet(first);
						const rows = grid.rows
							.slice(0, PREVIEW_ROWS)
							.map(row => row.slice(0, PREVIEW_COLUMNS).map(cell => cell.text));
						return ready(
							{ type: "table", rows },
							{ unit: "rows", count: grid.rows.length, more: grid.clippedRows },
						);
					}
					case "presentation": {
						const data = await readBinary();
						// Lazy like OfficeViews' loadSlides: the presentation reader loads with the first deck.
						const { readPresentation } = await import("../../panels/viewers/pptx");
						const slides = await readPresentation(data);
						const title = slides[0]?.title ?? slides[0]?.paragraphs[0]?.text ?? "";
						return ready(title ? { type: "title", text: title } : undefined, {
							unit: "slides",
							count: slides.length,
						});
					}
					case "csv": {
						const file = tabId
							? await window.omp.fs.read(path, TEXT_PREVIEW_BYTES, tabId)
							: await window.omp.fs.read(path, TEXT_PREVIEW_BYTES);
						if (!file.ok || file.binary) return ready();
						const count = file.truncated ? undefined : lineCount(file.content);
						const table = parseDelimited(file.content, fileExtension(path) === "tsv" ? "\t" : ",", PREVIEW_ROWS);
						const rows = table.rows.map(row => row.slice(0, PREVIEW_COLUMNS));
						return ready({ type: "table", rows }, count === undefined ? undefined : { unit: "rows", count });
					}
					default:
						return ready();
				}
			} catch {
				if (live) setState({ status: "failed" });
			}
		})();
		return () => {
			live = false;
		};
	}, [near, path, tabId, compact]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the callback is a notification, not an input
	useEffect(() => {
		if (state.status === "ready") onResolved?.(true);
		else if (state.status === "missing") onResolved?.(false);
	}, [state.status]);
	if (hideMissing && state.status === "missing") return null;
	const name = basename(path.replace(/[\\/]+$/, "")) || path;
	const kind = state.status === "ready" ? state.kind : fileCardKind(path);
	const Icon = ICONS[kind];
	const meta =
		state.status === "missing"
			? t("fileCard.deleted")
			: state.status === "ready"
				? [
						t(`fileCard.kind.${state.kind}`),
						state.count &&
							t(`fileCard.count.${state.count.unit}`, {
								count: `${state.count.count.toLocaleString(uiLocale())}${state.count.more ? "+" : ""}`,
							}),
						state.kind === "folder" ? null : formatBytes(state.size),
					]
						.filter(Boolean)
						.join(" · ")
				: t(`fileCard.kind.${kind}`);
	const open = () => {
		if (state.status === "missing") return;
		if (kind === "folder") useUiStore.getState().revealInFiles(path);
		else useUiStore.getState().openFilePreview(path);
	};
	const preview = state.status === "ready" ? state.preview : undefined;

	if (compact) {
		// A draft's mention: one 28px chip with the file's name (the type, size and path are its tooltip). The
		// strip's keyboard route (strip-roving.ts) reaches its button; Delete on it removes the mention.
		return (
			<div
				className={cx(
					"relative flex h-7 max-w-64 shrink-0 items-center rounded-(--sc-radius-full) border border-(--sc-border-subtle) text-sc-xs text-(--sc-text-secondary)",
					state.status === "missing" && "text-(--sc-warning)",
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
					disabled={state.status === "missing"}
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
	return (
		<div
			className="group relative flex w-44 shrink-0 flex-col overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle)"
			data-file-card={kind}
			data-state={state.status}
			ref={ref}
			title={path}
		>
			<button
				aria-label={t("fileCard.open", { name })}
				className="flex h-20 w-full items-center justify-center overflow-hidden border-b border-(--sc-divider) text-left focus-visible:outline-2 focus-visible:outline-(--sc-focus-ring) disabled:cursor-default"
				disabled={state.status === "missing"}
				onClick={open}
				type="button"
			>
				{preview?.type === "table" ? (
					<table aria-hidden className="w-full self-start table-fixed text-sc-2xs text-(--sc-text-secondary)">
						<tbody>
							{preview.rows.map((row, rowIndex) => (
								<tr className="border-b border-(--sc-divider)" key={rowIndex}>
									{row.map((cell, cellIndex) => (
										<td className="truncate px-1 py-0.5" key={cellIndex}>
											{cell}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				) : preview?.type === "title" ? (
					<span className="line-clamp-3 px-3 text-center text-sc-xs font-medium text-(--sc-text-secondary)">
						{preview.text}
					</span>
				) : (
					<Icon aria-hidden className="size-6 text-(--sc-text-muted)" />
				)}
			</button>
			<div className="flex min-w-0 flex-col gap-0.5 px-2 py-1.5">
				<span className="truncate font-mono text-sc-xs text-(--sc-text)">{name}</span>
				<span
					className={cx(
						"truncate text-sc-2xs tabular-nums",
						state.status === "missing" ? "text-(--sc-warning)" : "text-(--sc-text-muted)",
					)}
					data-file-card-meta
				>
					{meta}
				</span>
			</div>
		</div>
	);
}
