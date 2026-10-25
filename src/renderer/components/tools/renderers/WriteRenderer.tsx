import { FilePlus2, Settings2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DiffView } from "../../../lib/diff";
import { cx, headLines, languageFromPath, resultDetails, resultText } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { PREVIEW_SCROLL_LG, PREVIEW_TEXT_CHARS } from "../../../lib/preview";
import { asRecord, asString } from "../../../lib/wire-value";
import { CodeBlock } from "../../chat/CodeBlock";
import { MermaidBlock } from "../../chat/MermaidBlock";
import { SvgBlock } from "../../chat/SvgBlock";
import { DisclosureButton } from "../../common";
import { unifiedDiffStats } from "../diff-stats";
import { BodyPathLink, DiffStatChip, type ToolRendererProps } from "../ToolCard";
import { ProtocolWriteRenderer } from "./CoordinationRenderer";
import { DiagnosticsChip, DiagnosticsSection, resultDiagnostics } from "./Diagnostics";
import { liveDiffProps } from "./live-diff";

/** Written files drawn as a figure, as stock omp draws their fence in a reply. */
type WriteFigure = "svg" | "mermaid";

function writeFigure(path: string): WriteFigure | null {
	if (/\.svg$/i.test(path)) return "svg";
	if (/\.(?:mmd|mermaid)$/i.test(path)) return "mermaid";
	return null;
}

/**
 * A written .svg / .mmd / .mermaid file as a figure: the picture or diagram
 * with the code view (the card's usual diff or content) one icon away, all in
 * one box headed by the file name. An svg that does not parse yet (still
 * streaming, or broken) and a mermaid write still streaming show only the
 * code, as stock waits for a mermaid fence to close.
 */
function WriteFigureView({
	figure,
	content,
	fileName,
	streaming,
	codeView,
}: {
	figure: WriteFigure;
	content: string;
	fileName: string;
	streaming: boolean;
	codeView: (bare: boolean) => ReactNode;
}) {
	if (figure === "svg")
		return <SvgBlock code={content} codeView={codeView(true)} fallback={codeView(false)} title={fileName} />;
	if (streaming || content.trim() === "") return codeView(false);
	return <MermaidBlock code={content} codeView={codeView(true)} title={fileName} />;
}

/**
 * `write cfg://path[/save]` (stock pi-tui `tools/cfg-render.ts` describeCfgWrite):
 * the setting, its scope (session or saved), the outcome of the user's
 * approval, and `previous → value`; a saved value a higher layer still
 * shadows says so. `details.cfg` is `CfgWriteDetails` (values display-formatted, secrets redacted).
 */
function CfgWriteView({
	path,
	content,
	result,
	isError,
}: {
	path: string;
	content: string;
	result: unknown;
	isError?: boolean;
}) {
	const t = useT();
	const cfg = asRecord(resultDetails(result)?.cfg);
	const segments = path
		.trim()
		.slice("cfg://".length)
		.replace(/[?#].*$/s, "")
		.split(/[/.]/)
		.filter(Boolean);
	const urlSave = segments.length > 1 && segments.at(-1) === "save";
	if (urlSave) segments.pop();
	const settingPath = asString(cfg?.path) ?? segments.join(".");
	const save = typeof cfg?.save === "boolean" ? cfg.save : urlSave;
	const outcome = asString(cfg?.outcome);
	const value = asString(cfg?.value) ?? (content.trim() || "…");
	const previous = asString(cfg?.previous);
	const effective = asString(cfg?.effective);
	return (
		<div className="flex flex-col gap-1" data-tool-cfg-write>
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<Settings2 size={12} className="shrink-0 text-[var(--omp-dim)]" />
				<span className="min-w-0 truncate text-[var(--omp-muted)]">{settingPath}</span>
				<span className={cx("shrink-0 text-sc-xs", save ? "text-(--sc-accent)" : "text-(--sc-text-subtle)")}>
					{t(save ? "tools.cfg.persist" : "tools.cfg.session")}
				</span>
				{outcome === "declined" && (
					<span className="shrink-0 text-sc-xs text-(--sc-warning)">{t("tools.cfg.declined")}</span>
				)}
				{outcome === "unchanged" && (
					<span className="shrink-0 text-sc-xs text-(--sc-text-subtle)">{t("tools.cfg.unchanged")}</span>
				)}
			</div>
			{isError ? (
				<div className="whitespace-pre-wrap text-sc-sm text-(--sc-danger)">
					{resultText(result).trim() || t("tools.cfg.writeFailed")}
				</div>
			) : (
				<div className="break-words font-mono text-omp-sm">
					{previous !== undefined && <span className="text-[var(--omp-dim)]">{previous} </span>}
					<span className="text-[var(--omp-dim)]">→ </span>
					<span className="text-[var(--omp-tool-output)]">{value}</span>
				</div>
			)}
			{effective !== undefined && (
				<div className="text-sc-xs text-(--sc-warning)">{t("tools.cfg.shadowed", { value: effective })}</div>
			)}
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
	rowShowsTarget,
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
	if (/^cfg:\/\//i.test(path)) {
		return <CfgWriteView content={content} isError={isError} path={path} result={result} />;
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
	const diagnostics = isError ? [] : resultDiagnostics(details);
	// Failed writes must surface the reason (permission/conflict), not a
	// success-style preview of the requested content.
	const errorText = isError ? headLines(resultText(result), WRITE_PREVIEW_LINES) : null;

	const figure = writeFigure(path);
	// `bare`: inside a figure's box the code needs no border of its own.
	const codeView = diff
		? (_bare: boolean) => (
				<DiffView
					{...(livePreview ? liveDiffProps(diff) : { diff })}
					filePath={path}
					className={cx("rounded", PREVIEW_SCROLL_LG)}
				/>
			)
		: content
			? (bare: boolean) => (
					<>
						<CodeBlock
							bare={bare}
							code={liveContent}
							language={languageFromPath(path)}
							showLanguage={false}
							showCopy={false}
							startLine={livePreview ? Math.max(1, lineCount - liveContent.split("\n").length + 1) : undefined}
							maxHeightClass="max-h-72"
						/>
						{!livePreview && previewOmitted > 0 && (
							<div className="text-omp-xs text-[var(--omp-dim)]">
								{t("tools.read.more", { count: previewOmitted })}
							</div>
						)}
					</>
				)
			: null;
	if (livePreview) {
		if (isError) return <div className="whitespace-pre-wrap text-sc-sm text-(--sc-danger)">{errorText?.head}</div>;
		return (
			// Streaming content follows its tail; a landed diff marks its newest hunk instead.
			<div className="omp-tool-editor omp-tool-write" data-live-focus={diff || !content ? undefined : "end"}>
				{codeView?.(false) || (
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
				{/* Its own box: the disclosure is full width, this one is as wide as its icons. */}
				<span className="flex shrink-0">
					<DisclosureButton
						aria-label={t("tools.write.content")}
						chevronClassName="size-3 text-[var(--omp-dim)]"
						className="gap-1.5 transition-colors hover:text-[var(--omp-text)]"
						onToggle={() => setOpen(v => !v)}
						open={open}
					>
						<FilePlus2 aria-hidden size={12} className="shrink-0 text-[var(--omp-dim)]" />
					</DisclosureButton>
				</span>
				<BodyPathLink openPath={openPath} path={path} rowShowsTarget={rowShowsTarget} />
				<span className="ml-auto flex shrink-0 items-center gap-1.5 text-omp-xs text-[var(--omp-dim)]">
					{stats && !rowShowsTarget && <DiffStatChip stats={stats} />}
					{overwritten && !diff && (
						<span className="text-[var(--omp-warning)]">{t("tools.write.overwritten")}</span>
					)}
					{details?.madeExecutable === true && (
						<span className="text-[var(--omp-success)]">{t("tools.write.executable")}</span>
					)}
					{rowShowsTarget ? null : <DiagnosticsChip files={diagnostics} />}
					<span>{t("tools.write.lines", { count: lineCount })}</span>
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
					<WriteFigureView
						codeView={codeView}
						content={content}
						figure={figure}
						fileName={path.split(/[\\/]/).pop() || path}
						streaming={isPartial === true}
					/>
				) : (
					codeView(false)
				))}
			<DiagnosticsSection files={diagnostics} />
		</div>
	);
}
