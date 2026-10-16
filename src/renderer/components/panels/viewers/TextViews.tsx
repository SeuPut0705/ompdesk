/**
 * Viewers fed by `fs.read`: code/text, Markdown, JSON, CSV/TSV, HTML, Mermaid
 * and Jupyter notebooks. TextFileFrame owns the read and its end states; a NUL
 * byte in the content hands the file to the hex view instead. A `line` (from a
 * `path:line` link) opens documents on their source and marks that line; the
 * rendered/source choice is otherwise remembered per path (stores/ui).
 */
import { ListTree } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AnsiText } from "../../../lib/ansi";
import { languageFromPath } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { useUiStore } from "../../../stores/ui";
import { CodeBlock } from "../../chat/CodeBlock";
import { FigureModeToggle } from "../../chat/Figure";
import { MermaidBlock } from "../../chat/MermaidBlock";
import { IconButton, ZoomableImage } from "../../common";
import { CodeView, useWrapToggle } from "./CodeView";
import { fileExtension } from "./file-kind";
import { HexView } from "./HexView";
import { parseDelimited, parseNotebook, prettyJson } from "./parse";
import { TEXT_FULL_BYTES, useTextFile } from "./use-file-read";
import { TruncatedNote, useReportFileInfo, ViewerFailure, ViewerLoading, ViewerToolbar } from "./viewer-chrome";

/** Table rows rendered before the "showing the first N rows" note. */
export const TABLE_ROW_CAP = 2000;

interface TextViewProps {
	path: string;
	tabId: string | undefined;
	/** 1-based line to open at (a `path:line` link). */
	line?: number;
}

function TextFileFrame({
	path,
	tabId,
	toolbar,
	render,
}: TextViewProps & { toolbar?: ReactNode; render: (content: string) => ReactNode }) {
	const { state, loadMore } = useTextFile(path, tabId);
	useReportFileInfo(state.status === "ready" || state.status === "binary" ? state.size : null);
	if (state.status === "loading") return <ViewerLoading />;
	if (state.status === "error") return <ViewerFailure failure={state.failure} />;
	if (state.status === "binary") return <HexView path={path} tabId={tabId} />;
	return (
		<div className="flex h-full min-h-0 flex-col">
			{toolbar}
			<div className="min-h-0 flex-1 overflow-auto" data-viewer-scroll>
				{render(state.content)}
			</div>
			{state.truncated && (
				<TruncatedNote
					canLoadMore={state.maxBytes < TEXT_FULL_BYTES}
					loadingMore={state.loadingMore}
					onLoadMore={loadMore}
					shownBytes={state.maxBytes}
					size={state.size}
				/>
			)}
		</div>
	);
}

export function CodeFileView({ path, tabId, line }: TextViewProps) {
	const t = useT();
	const { wrap, toggle } = useWrapToggle();
	const log = fileExtension(path) === "log";
	return (
		<TextFileFrame
			path={path}
			render={content =>
				// A captured terminal log carries SGR colour escapes: paint them instead of showing ESC bytes.
				log && !line && content.includes("\u001b[") ? (
					<pre
						className={`m-0 p-3 font-mono text-sc-sm leading-(--sc-leading-normal) text-(--sc-text) ${wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "w-max min-w-full whitespace-pre"}`}
						data-ansi-log
					>
						<AnsiText text={content} />
					</pre>
				) : (
					<CodeView code={content} language={languageFromPath(path)} targetLine={line} wrap={wrap} />
				)
			}
			tabId={tabId}
			toolbar={<ViewerToolbar label={t("fileViewer.toolbar")}>{toggle}</ViewerToolbar>}
		/>
	);
}

type DocumentMode = "rendered" | "source";

/** Source when a line is targeted, else the path's remembered mode (rendered by default). */
function useDocumentMode(path: string, line: number | undefined): [DocumentMode, (mode: DocumentMode) => void] {
	const [mode, setLocalMode] = useState<DocumentMode>(() =>
		line ? "source" : (useUiStore.getState().fileViewModes.get(path) ?? "rendered"),
	);
	useEffect(() => {
		if (line) setLocalMode("source");
	}, [line]);
	const setMode = (next: DocumentMode) => {
		setLocalMode(next);
		useUiStore.getState().setFileViewMode(path, next);
	};
	return [mode, setMode];
}

interface OutlineHeading {
	id: string;
	text: string;
	level: number;
}

/** Rendered Markdown with an optional heading outline read from the rendered ids (GitHub slugs). */
function MarkdownBody({ content, outline }: { content: string; outline: boolean }) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	const [headings, setHeadings] = useState<OutlineHeading[]>([]);
	useEffect(() => {
		const root = ref.current;
		if (!outline || !root || !content) return;
		setHeadings(
			Array.from(root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]"), heading => ({
				id: heading.id,
				text: heading.textContent ?? "",
				level: Number(heading.tagName.slice(1)),
			})),
		);
	}, [outline, content]);
	return (
		<>
			{outline && (
				<nav
					aria-label={t("fileViewer.outline")}
					className="max-h-48 overflow-y-auto border-b border-(--sc-divider) px-2 py-1.5"
					data-markdown-outline
				>
					{headings.length === 0 ? (
						<p className="px-1.5 py-1 text-sc-xs text-(--sc-text-muted)">{t("fileViewer.outlineEmpty")}</p>
					) : (
						<ul className="m-0 list-none p-0">
							{headings.map(heading => (
								<li key={heading.id}>
									<button
										className="w-full truncate rounded-(--sc-radius-sm) py-0.5 pe-1.5 text-start text-sc-sm text-(--sc-text-muted) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
										onClick={() =>
											Array.from(ref.current?.querySelectorAll<HTMLElement>("[id]") ?? [])
												.find(element => element.id === heading.id)
												?.scrollIntoView?.({ block: "start" })
										}
										style={{ paddingInlineStart: `${0.375 + (heading.level - 1) * 0.75}rem` }}
										title={heading.text}
										type="button"
									>
										{heading.text}
									</button>
								</li>
							))}
						</ul>
					)}
				</nav>
			)}
			<div className="p-4 text-sc-md text-(--sc-text)" data-markdown-rendered ref={ref}>
				<MarkdownRenderer content={content} />
			</div>
		</>
	);
}

function ModeTabs({ mode, onChange }: { mode: DocumentMode; onChange: (mode: DocumentMode) => void }) {
	const t = useT();
	return (
		<FigureModeToggle
			codeLabel={t("fileViewer.source")}
			groupLabel={t("fileViewer.mode")}
			mode={mode === "source" ? "code" : "preview"}
			onChange={next => onChange(next === "code" ? "source" : "rendered")}
			previewLabel={t("fileViewer.rendered")}
		/>
	);
}

export function MarkdownFileView({ path, tabId, line }: TextViewProps) {
	const t = useT();
	const [mode, setMode] = useDocumentMode(path, line);
	const [outline, setOutline] = useState(false);
	const { wrap, toggle } = useWrapToggle();
	return (
		<TextFileFrame
			path={path}
			render={content =>
				mode === "rendered" ? (
					<MarkdownBody content={content} outline={outline} />
				) : (
					<CodeView code={content} language="markdown" targetLine={line} wrap={wrap} />
				)
			}
			tabId={tabId}
			toolbar={
				<ViewerToolbar label={t("fileViewer.toolbar")}>
					<ModeTabs mode={mode} onChange={setMode} />
					{mode === "source" ? (
						toggle
					) : (
						<IconButton
							icon={<ListTree />}
							label={t("fileViewer.outline")}
							onClick={() => setOutline(open => !open)}
							pressed={outline}
							size="sm"
						/>
					)}
				</ViewerToolbar>
			}
		/>
	);
}

export function HtmlFileView({ path, tabId, line }: TextViewProps) {
	const t = useT();
	const [mode, setMode] = useDocumentMode(path, line);
	const { wrap, toggle } = useWrapToggle();
	return (
		<TextFileFrame
			path={path}
			render={content =>
				mode === "rendered" ? (
					// Empty sandbox: no scripts, no same-origin, no forms, popups or
					// top navigation; the page inherits this window's CSP as srcdoc.
					// White canvas like a browser tab: pages assume it.
					<iframe
						className="block h-full min-h-80 w-full border-0 bg-white"
						data-html-rendered
						sandbox=""
						srcDoc={content}
						title={t("fileViewer.htmlFrame", { name: path })}
					/>
				) : (
					<CodeView code={content} language="xml" targetLine={line} wrap={wrap} />
				)
			}
			tabId={tabId}
			toolbar={
				<ViewerToolbar label={t("fileViewer.toolbar")}>
					<ModeTabs mode={mode} onChange={setMode} />
					{mode === "source" && toggle}
				</ViewerToolbar>
			}
		/>
	);
}

/**
 * .mmd/.mermaid: the figure's own header holds the Rendered/Source switch (a
 * diagram that does not parse shows only the source); the choice is remembered per path.
 */
export function MermaidFileView({ path, tabId, line }: TextViewProps) {
	const [mode, setMode] = useDocumentMode(path, line);
	return (
		<TextFileFrame
			path={path}
			render={content => (
				<div className="p-3" data-mermaid-rendered>
					<MermaidBlock
						code={content}
						codeView={<CodeView code={content} language="plaintext" targetLine={line} wrap={false} />}
						mode={mode === "source" ? "code" : "preview"}
						onModeChange={next => setMode(next === "code" ? "source" : "rendered")}
					/>
				</div>
			)}
			tabId={tabId}
		/>
	);
}

function JsonBody({
	content,
	lines,
	wrap,
	targetLine,
}: {
	content: string;
	lines: boolean;
	wrap: boolean;
	targetLine: number | undefined;
}) {
	const t = useT();
	// A targeted line refers to the file as written, so it skips pretty-printing.
	const pretty = useMemo(() => (targetLine ? null : prettyJson(content, lines)), [content, lines, targetLine]);
	if (pretty !== null) return <CodeView code={pretty} language="json" wrap={wrap} />;
	if (targetLine) return <CodeView code={content} language="json" targetLine={targetLine} wrap={wrap} />;
	return (
		<>
			<p className="px-3 pt-2 text-sc-xs text-(--sc-text-muted)" data-json-invalid>
				{t("fileViewer.jsonInvalid")}
			</p>
			<CodeView code={content} language="plaintext" wrap={wrap} />
		</>
	);
}

export function JsonFileView({ path, tabId, line }: TextViewProps) {
	const t = useT();
	const { wrap, toggle } = useWrapToggle();
	const ext = fileExtension(path);
	return (
		<TextFileFrame
			path={path}
			render={content => (
				<JsonBody content={content} lines={ext === "jsonl" || ext === "ndjson"} targetLine={line} wrap={wrap} />
			)}
			tabId={tabId}
			toolbar={<ViewerToolbar label={t("fileViewer.toolbar")}>{toggle}</ViewerToolbar>}
		/>
	);
}

function TableBody({ content, delimiter }: { content: string; delimiter: string }) {
	const t = useT();
	const table = useMemo(() => parseDelimited(content, delimiter, TABLE_ROW_CAP + 1), [content, delimiter]);
	const [header, ...body] = table.rows;
	if (!header) return <p className="p-4 text-sc-sm text-(--sc-text-muted)">{t("fileViewer.tableEmpty")}</p>;
	const columns = Math.max(header.length, ...body.map(row => row.length));
	return (
		<>
			<table className="min-w-full border-separate border-spacing-0 font-mono text-sc-sm" data-table-view>
				<thead className="sticky top-0 z-(--sc-z-sticky)">
					<tr>
						<th className="sticky left-0 border-b border-(--sc-border-subtle) bg-(--sc-surface-2) px-2 py-1" />
						{Array.from({ length: columns }, (_, c) => (
							<th
								className="border-b border-(--sc-border-subtle) bg-(--sc-surface-2) px-2 py-1 text-left font-semibold whitespace-nowrap text-(--sc-text)"
								key={c}
								scope="col"
							>
								{header[c] ?? ""}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((row, r) => (
						<tr key={r}>
							<th
								className="sticky left-0 border-b border-(--sc-divider) bg-(--sc-surface-2) px-2 py-0.5 text-right font-normal text-(--sc-text-muted)"
								scope="row"
							>
								{r + 1}
							</th>
							{Array.from({ length: columns }, (_, c) => (
								<td
									className="max-w-96 truncate border-b border-(--sc-divider) px-2 py-0.5 whitespace-pre text-(--sc-text)"
									key={c}
									title={row[c]}
								>
									{row[c] ?? ""}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{table.clipped && (
				<p className="px-3 py-2 text-sc-xs text-(--sc-text-muted)" data-table-clipped>
					{t("fileViewer.tableClipped", { rows: TABLE_ROW_CAP })}
				</p>
			)}
		</>
	);
}

export function CsvFileView({ path, tabId }: TextViewProps) {
	const delimiter = fileExtension(path) === "tsv" ? "\t" : ",";
	return (
		<TextFileFrame
			path={path}
			render={content => <TableBody content={content} delimiter={delimiter} />}
			tabId={tabId}
		/>
	);
}

function NotebookBody({ content }: { content: string }) {
	const t = useT();
	const notebook = useMemo(() => parseNotebook(content), [content]);
	if (!notebook) {
		return (
			<>
				<p className="px-3 pt-2 text-sc-xs text-(--sc-text-muted)" data-notebook-invalid>
					{t("fileViewer.notebookInvalid")}
				</p>
				<CodeView code={content} language="json" wrap={false} />
			</>
		);
	}
	if (notebook.cells.length === 0) {
		return <p className="p-4 text-sc-sm text-(--sc-text-muted)">{t("fileViewer.notebookEmpty")}</p>;
	}
	return (
		<div className="flex flex-col gap-3 p-3" data-notebook-view>
			{notebook.cells.map((cell, index) =>
				cell.kind === "markdown" ? (
					<div className="px-1 text-sc-md text-(--sc-text)" data-cell="markdown" key={index}>
						<MarkdownRenderer content={cell.source} />
					</div>
				) : cell.kind === "code" ? (
					<div className="flex min-w-0 flex-col gap-1.5" data-cell="code" key={index}>
						<span className="font-mono text-sc-xs text-(--sc-text-muted)">{`In [${cell.executionCount ?? " "}]`}</span>
						<CodeBlock code={cell.source} language={notebook.language} showLanguage={false} />
						{cell.outputs.map((output, k) =>
							output.kind === "image" ? (
								<div data-cell-output="image" key={k}>
									<ZoomableImage
										alt={t("fileViewer.notebookOutputImage", { cell: index + 1 })}
										className="max-w-full"
										src={`data:${output.mime};base64,${output.base64}`}
									/>
								</div>
							) : (
								<pre
									className="overflow-x-auto px-1 font-mono text-sc-sm leading-(--sc-leading-normal) whitespace-pre-wrap break-words text-(--sc-text)"
									data-cell-output="text"
									key={k}
								>
									<AnsiText text={output.text} />
								</pre>
							),
						)}
					</div>
				) : (
					<pre
						className="overflow-x-auto px-1 font-mono text-sc-sm whitespace-pre-wrap break-words text-(--sc-text-muted)"
						data-cell="raw"
						key={index}
					>
						{cell.source}
					</pre>
				),
			)}
		</div>
	);
}

export function NotebookFileView({ path, tabId }: TextViewProps) {
	return <TextFileFrame path={path} render={content => <NotebookBody content={content} />} tabId={tabId} />;
}
