import { ChevronDown, ChevronRight, FilePlus2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DiffView } from "../../lib/diff";
import { cx, headLines, languageFromPath, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_LG, PREVIEW_TEXT_CHARS } from "../../lib/preview";
import { CodeBlock } from "../chat/CodeBlock";
import { MermaidBlock } from "../chat/MermaidBlock";
import { type PreviewMode, PreviewModeTabs, SvgImage, useSanitizedSvg } from "../chat/SvgBlock";
import { ProtocolWriteRenderer } from "./CoordinationRenderer";
import { unifiedDiffStats } from "./diff-stats";
import { liveDiffPreview } from "./live-diff";
import { PathLink } from "./PathLink";
import { DiffStatChip, ToolPathTarget, type ToolRendererProps } from "./ToolCard";

/** Written files drawn as a figure, as stock omp draws their fence in a reply. */
type WriteFigure = "svg" | "mermaid";

function writeFigure(path: string): WriteFigure | null {
	if (/\.svg$/i.test(path)) return "svg";
	if (/\.(?:mmd|mermaid)$/i.test(path)) return "mermaid";
	return null;
}

/**
 * Preview/Code switch over a figure write. The code side is the card's usual
 * diff or content view. An svg that does not parse yet (still streaming, or
 * broken) and a mermaid write still streaming show only the code, as stock
 * waits for a mermaid fence to close.
 */
function WriteFigurePreview({
	figure,
	content,
	streaming,
	codeView,
}: {
	figure: WriteFigure;
	content: string;
	streaming: boolean;
	codeView: ReactNode;
}) {
	const [mode, setMode] = useState<PreviewMode>("preview");
	const svg = useSanitizedSvg(figure === "svg" ? content : "");
	const preview =
		figure === "svg"
			? svg !== null && <SvgImage svg={svg} />
			: !streaming && content.trim() !== "" && <MermaidBlock code={content} />;
	if (!preview) return codeView;
	return (
		<div className="flex flex-col items-start gap-1.5" data-write-figure={figure}>
			<PreviewModeTabs mode={mode} onChange={setMode} />
			<div className="flex w-full flex-col gap-1.5">{mode === "preview" ? preview : codeView}</div>
		</div>
	);
}

/**
 * File write: path header + collapsible preview. When the write overwrote an
 * existing file and the sidecar captured the pre-write content, the detail
 * view is the old→new diff (same format the edit tool emits); creates and
 * diff-less overwrites fall back to the written-content preview.
 */
/** Preview ceiling for diff-less write content (lines entered into the DOM). */
const WRITE_PREVIEW_LINES = 500;
export function WriteRenderer({
	args,
	result,
	isError,
	isPartial,
	partialResult,
	interrupted,
	livePreview,
}: ToolRendererProps) {
	const t = useT();
	const [open, setOpen] = useState(livePreview === true);
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
	const content = typeof args.content === "string" ? args.content : "";
	if (/^(?:agent|proc):\/\//i.test(path)) {
		return (
			<ProtocolWriteRenderer
				args={args}
				content={content}
				interrupted={interrupted}
				isError={isError}
				isPartial={isPartial}
				partialResult={partialResult}
				result={result}
				target={path}
			/>
		);
	}
	const lineCount = content ? content.split("\n").length : 0;
	// Preview ceiling: the full written file must not enter the DOM — the
	// height class only clips after layout. Copy stays available via the file.
	const { head: previewContent, omitted: previewOmitted } = headLines(content, WRITE_PREVIEW_LINES);
	const liveContent = livePreview
		? content.slice(-PREVIEW_TEXT_CHARS).split("\n").slice(-WRITE_PREVIEW_LINES).join("\n")
		: previewContent;

	const details = resultDetails(isPartial ? (partialResult ?? result) : result);
	const diff = typeof details?.diff === "string" && details.diff ? details.diff : null;
	const overwritten = details?.overwritten === true;
	const openPath = typeof details?.resolvedPath === "string" ? details.resolvedPath : path;
	const stats = diff ? unifiedDiffStats(diff) : null;
	// Failed writes must surface the reason (permission/conflict), not a
	// success-style preview of the requested content.
	const errorText = isError ? headLines(resultText(result), WRITE_PREVIEW_LINES) : null;

	const figure = writeFigure(path);
	const codeView = diff ? (
		<DiffView
			diff={livePreview ? liveDiffPreview(diff) : diff}
			filePath={path}
			className={cx("rounded", PREVIEW_SCROLL_LG)}
		/>
	) : content ? (
		<>
			<CodeBlock
				code={liveContent}
				language={languageFromPath(path)}
				showLanguage={false}
				showCopy={false}
				startLine={livePreview ? Math.max(1, lineCount - liveContent.split("\n").length + 1) : undefined}
				maxHeightClass="max-h-72"
			/>
			{!livePreview && previewOmitted > 0 && (
				<div className="text-omp-xs text-[var(--omp-dim)]">
					{t("tools.read.more", { count: previewOmitted, plural: previewOmitted === 1 ? "" : "s" })}
				</div>
			)}
		</>
	) : null;
	if (livePreview) {
		if (isError) return <div className="whitespace-pre-wrap text-sc-sm text-(--sc-danger)">{errorText?.head}</div>;
		return (
			<div className="omp-tool-editor omp-tool-write">
				{codeView || (
					<div className="text-sc-sm text-(--sc-text-muted)">
						{isPartial ? t("tools.edit.applying") : t("tools.read.empty")}
					</div>
				)}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<button
					type="button"
					onClick={() => setOpen(v => !v)}
					aria-expanded={open}
					className="flex shrink-0 items-center gap-1.5 transition-colors hover:text-[var(--omp-text)]"
				>
					{open ? (
						<ChevronDown size={12} className="shrink-0 text-[var(--omp-dim)]" />
					) : (
						<ChevronRight size={12} className="shrink-0 text-[var(--omp-dim)]" />
					)}
					<FilePlus2 size={12} className="shrink-0 text-[var(--omp-dim)]" />
				</button>
				<PathLink path={openPath} className="truncate">
					<ToolPathTarget path={path} />
				</PathLink>
				<span className="ml-auto flex shrink-0 items-center gap-1.5 text-omp-xs text-[var(--omp-dim)]">
					{stats && <DiffStatChip stats={stats} />}
					{overwritten && !diff && (
						<span className="text-[var(--omp-warning)]">{t("tools.write.overwritten")}</span>
					)}
					<span>{t("tools.write.lines", { count: lineCount, plural: lineCount === 1 ? "" : "s" })}</span>
				</span>
			</div>
			{open && isError && errorText?.head && (
				<div className="max-h-72 overflow-y-auto rounded-lg border border-[var(--omp-error)]/35 bg-[var(--omp-error-dim)] px-3 py-2 font-mono text-omp-sm break-words whitespace-pre-wrap text-[var(--omp-error)]">
					{errorText.head}
				</div>
			)}
			{!isError &&
				open &&
				codeView &&
				(figure ? (
					<WriteFigurePreview
						codeView={codeView}
						content={content}
						figure={figure}
						streaming={isPartial === true}
					/>
				) : (
					codeView
				))}
		</div>
	);
}
