/**
 * Viewers fed by `fs.read`: code/text, Markdown, JSON, CSV/TSV, HTML and
 * Jupyter notebooks. TextFileFrame owns the read and its end states; a NUL
 * byte in the content hands the file to the hex view instead.
 */
import { type ReactNode, useMemo, useState } from "react";
import { AnsiText } from "../../../lib/ansi";
import { languageFromPath } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { CodeBlock } from "../../chat/CodeBlock";
import { Tabs, ZoomableImage } from "../../common";
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

export function CodeFileView({ path, tabId }: TextViewProps) {
	const t = useT();
	const { wrap, toggle } = useWrapToggle();
	return (
		<TextFileFrame
			path={path}
			render={content => <CodeView code={content} language={languageFromPath(path)} wrap={wrap} />}
			tabId={tabId}
			toolbar={<ViewerToolbar label={t("fileViewer.toolbar")}>{toggle}</ViewerToolbar>}
		/>
	);
}

type DocumentMode = "rendered" | "source";

function ModeTabs({ mode, onChange }: { mode: DocumentMode; onChange: (mode: DocumentMode) => void }) {
	const t = useT();
	return (
		<Tabs
			activeId={mode}
			ariaLabel={t("fileViewer.mode")}
			compact
			onChange={id => onChange(id === "source" ? "source" : "rendered")}
			tabs={[
				{ id: "rendered", label: t("fileViewer.rendered") },
				{ id: "source", label: t("fileViewer.source") },
			]}
			variant="segmented"
		/>
	);
}

export function MarkdownFileView({ path, tabId }: TextViewProps) {
	const t = useT();
	const [mode, setMode] = useState<DocumentMode>("rendered");
	const { wrap, toggle } = useWrapToggle();
	return (
		<TextFileFrame
			path={path}
			render={content =>
				mode === "rendered" ? (
					<div className="p-4 text-omp-md text-(--omp-text)" data-markdown-rendered>
						<MarkdownRenderer content={content} />
					</div>
				) : (
					<CodeView code={content} language="markdown" wrap={wrap} />
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

export function HtmlFileView({ path, tabId }: TextViewProps) {
	const t = useT();
	const [mode, setMode] = useState<DocumentMode>("rendered");
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
					<CodeView code={content} language="xml" wrap={wrap} />
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

function JsonBody({ content, lines, wrap }: { content: string; lines: boolean; wrap: boolean }) {
	const t = useT();
	const pretty = useMemo(() => prettyJson(content, lines), [content, lines]);
	if (pretty !== null) return <CodeView code={pretty} language="json" wrap={wrap} />;
	return (
		<>
			<p className="px-3 pt-2 text-omp-xs text-(--omp-dim)" data-json-invalid>
				{t("fileViewer.jsonInvalid")}
			</p>
			<CodeView code={content} language="plaintext" wrap={wrap} />
		</>
	);
}

export function JsonFileView({ path, tabId }: TextViewProps) {
	const t = useT();
	const { wrap, toggle } = useWrapToggle();
	const ext = fileExtension(path);
	return (
		<TextFileFrame
			path={path}
			render={content => <JsonBody content={content} lines={ext === "jsonl" || ext === "ndjson"} wrap={wrap} />}
			tabId={tabId}
			toolbar={<ViewerToolbar label={t("fileViewer.toolbar")}>{toggle}</ViewerToolbar>}
		/>
	);
}

function TableBody({ content, delimiter }: { content: string; delimiter: string }) {
	const t = useT();
	const table = useMemo(() => parseDelimited(content, delimiter, TABLE_ROW_CAP + 1), [content, delimiter]);
	const [header, ...body] = table.rows;
	if (!header) return <p className="p-4 text-omp-sm text-(--omp-dim)">{t("fileViewer.tableEmpty")}</p>;
	const columns = Math.max(header.length, ...body.map(row => row.length));
	return (
		<>
			<table className="min-w-full border-separate border-spacing-0 font-mono text-omp-sm" data-table-view>
				<thead className="sticky top-0 z-10">
					<tr>
						<th className="sticky left-0 border-b border-(--omp-border-muted) bg-(--omp-code-bg) px-2 py-1" />
						{Array.from({ length: columns }, (_, c) => (
							<th
								className="border-b border-(--omp-border-muted) bg-(--omp-code-bg) px-2 py-1 text-left font-semibold whitespace-nowrap text-(--omp-text)"
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
								className="sticky left-0 border-b border-(--omp-border-muted)/50 bg-(--omp-code-bg) px-2 py-0.5 text-right font-normal text-(--omp-dim)"
								scope="row"
							>
								{r + 1}
							</th>
							{Array.from({ length: columns }, (_, c) => (
								<td
									className="max-w-96 truncate border-b border-(--omp-border-muted)/50 px-2 py-0.5 whitespace-pre text-(--omp-text)"
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
				<p className="px-3 py-2 text-omp-xs text-(--omp-dim)" data-table-clipped>
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
				<p className="px-3 pt-2 text-omp-xs text-(--omp-dim)" data-notebook-invalid>
					{t("fileViewer.notebookInvalid")}
				</p>
				<CodeView code={content} language="json" wrap={false} />
			</>
		);
	}
	if (notebook.cells.length === 0) {
		return <p className="p-4 text-omp-sm text-(--omp-dim)">{t("fileViewer.notebookEmpty")}</p>;
	}
	return (
		<div className="flex flex-col gap-3 p-3" data-notebook-view>
			{notebook.cells.map((cell, index) =>
				cell.kind === "markdown" ? (
					<div className="px-1 text-omp-md text-(--omp-text)" data-cell="markdown" key={index}>
						<MarkdownRenderer content={cell.source} />
					</div>
				) : cell.kind === "code" ? (
					<div className="flex min-w-0 flex-col gap-1.5" data-cell="code" key={index}>
						<span className="font-mono text-omp-xs text-(--omp-dim)">{`In [${cell.executionCount ?? " "}]`}</span>
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
									className="overflow-x-auto px-1 font-mono text-omp-sm leading-[1.5] whitespace-pre-wrap text-(--omp-text)"
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
						className="overflow-x-auto px-1 font-mono text-omp-sm whitespace-pre-wrap text-(--omp-muted)"
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
