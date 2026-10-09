/**
 * Files drawer viewer: picks the view for a path (file-kind.ts) and relays
 * the size/MIME the view's read returned to the drawer header. Every view
 * ends in content, an error, or a too-large card.
 */
import {
	File,
	FileArchive,
	FileAudio,
	FileBadge,
	FileCode,
	FileImage,
	FileJson,
	FileSpreadsheet,
	FileText,
	FileType,
	FileVideo,
} from "lucide-react";
import type { ReactNode } from "react";
import { type FileIconKind, fileIconKind, type ViewerKind, viewerKind } from "./file-kind";
import { HexView } from "./HexView";
import { AvView, ImageView } from "./MediaViews";
import { DocxView, PptxView, XlsxView } from "./OfficeViews";
import { PdfView } from "./PdfView";
import {
	CodeFileView,
	CsvFileView,
	HtmlFileView,
	JsonFileView,
	MarkdownFileView,
	MermaidFileView,
	NotebookFileView,
} from "./TextViews";
import { type FileInfo, FileInfoContext } from "./viewer-chrome";

export function FileViewer({
	path,
	tabId,
	onInfo,
}: {
	path: string;
	tabId: string | undefined;
	/** Must be stable (views report from effects). */
	onInfo: (info: FileInfo) => void;
}) {
	const kind = viewerKind(path);
	const views: Record<ViewerKind, ReactNode> = {
		markdown: <MarkdownFileView path={path} tabId={tabId} />,
		code: <CodeFileView path={path} tabId={tabId} />,
		image: <ImageView path={path} tabId={tabId} />,
		pdf: <PdfView path={path} tabId={tabId} />,
		audio: <AvView kind="audio" path={path} tabId={tabId} />,
		video: <AvView kind="video" path={path} tabId={tabId} />,
		csv: <CsvFileView path={path} tabId={tabId} />,
		json: <JsonFileView path={path} tabId={tabId} />,
		html: <HtmlFileView path={path} tabId={tabId} />,
		notebook: <NotebookFileView path={path} tabId={tabId} />,
		mermaid: <MermaidFileView path={path} tabId={tabId} />,
		docx: <DocxView path={path} tabId={tabId} />,
		xlsx: <XlsxView path={path} tabId={tabId} />,
		pptx: <PptxView path={path} tabId={tabId} />,
		office: <HexView office path={path} tabId={tabId} />,
		binary: <HexView path={path} tabId={tabId} />,
	};
	return (
		<FileInfoContext.Provider value={onInfo}>
			<div className="h-full min-h-0" data-viewer-kind={kind} key={path}>
				{views[kind]}
			</div>
		</FileInfoContext.Provider>
	);
}

const ICONS: Record<FileIconKind, typeof File> = {
	code: FileCode,
	text: FileText,
	markdown: FileType,
	image: FileImage,
	video: FileVideo,
	audio: FileAudio,
	pdf: FileBadge,
	archive: FileArchive,
	table: FileSpreadsheet,
	json: FileJson,
	file: File,
};

/** Type-aware tree glyph for a file path. */
export function FileIcon({ path, size, className }: { path: string; size: number; className?: string }) {
	const kind = fileIconKind(path);
	const Icon = ICONS[kind];
	return <Icon className={className} data-file-icon={kind} size={size} />;
}
