import { FileText, Globe, Settings2 } from "lucide-react";
import {
	basename,
	extractResultImage,
	headLines,
	languageFromPath,
	resultDetails,
	resultText,
} from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { PREVIEW_HEIGHT_LG, PREVIEW_SCROLL_LG, READ_PREVIEW_LINES } from "../../../lib/preview";
import { asArray, asNumber, asRecord, asString } from "../../../lib/wire-value";
import { CodeBlock } from "../../chat/CodeBlock";
import { PathLink } from "../media/PathLink";
import { ToolImage } from "../media/ToolImage";
import { ToolPathTarget, type ToolRendererProps } from "../ToolCard";
import { ProcReadRenderer } from "./CoordinationRenderer";
import { metaTruncation, TruncationNote } from "./output-meta";

/**
 * File read: path header + syntax-highlighted preview. Prefers the sidecar's
 * structured `details.displayContent` (prefix-free text + real start line) so
 * ranged/hashline reads show correct gutter numbers instead of selector
 * prefixes; falls back to the model-facing result text for non-text kinds.
 */
interface ReadToolDetails {
	kind?: "file" | "url";
	resolvedPath?: string;
	/** Stock read's absolute path of the image or video it showed. */
	mediaPath?: string;
	url?: string;
	finalUrl?: string;
	contentType?: string;
	method?: string;
	notes?: unknown;
	truncated?: boolean;
	displayContent?: { text: string; startLine: number; lineNumbers?: Array<number | null> };
	proc?: unknown;
	cfg?: unknown;
	suffixResolution?: { from?: unknown; to?: unknown };
	summary?: { elidedSpans?: unknown };
	conflictCount?: unknown;
}

/** `cfg://advisor/enabled` → `advisor.enabled` (stock pi-tui `tools/cfg-url.ts` `parseCfgUrl` segments). */
function cfgUrlPath(url: string): string | null {
	if (!/^cfg:\/\//i.test(url.trim())) return null;
	return url
		.trim()
		.slice("cfg://".length)
		.replace(/[?#].*$/s, "")
		.split(/[/.]/)
		.filter(Boolean)
		.join(".");
}

/** Host of a URL for the "from …" redirect note; the raw text when it does not parse. */
function urlHost(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/** Strip a trailing read selector (`file.ts:50-100`, `db.sqlite:users`) for
 * display and language detection; drive letters (`C:/x`) stay intact. */
function stripReadSelector(path: string): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
	const index = path.lastIndexOf(":");
	return index > 1 ? path.slice(0, index) : path;
}

export function ReadRenderer({ args, result, isError, isPartial, partialResult, livePreview }: ToolRendererProps) {
	const t = useT();
	const path = typeof args.path === "string" ? args.path : "";
	const effective = isPartial ? partialResult : result;
	const details = (resultDetails(effective) ?? {}) as ReadToolDetails;
	if (/^proc:\/\//i.test(path) || details.proc !== undefined) {
		return (
			<ProcReadRenderer
				args={args}
				id={path.replace(/^proc:\/\//i, "")}
				isError={isError}
				isPartial={isPartial}
				partialResult={partialResult}
				procDetails={details.proc}
				result={result}
			/>
		);
	}
	const structuredPath = details.resolvedPath ?? details.finalUrl ?? details.url;
	const basePath = typeof structuredPath === "string" && structuredPath ? structuredPath : stripReadSelector(path);
	const display = details.displayContent;
	const image = extractResultImage(effective);
	const rawText = display?.text ?? resultText(effective);
	const { head, omitted } = headLines(rawText, READ_PREVIEW_LINES);
	// `read cfg://…` (stock `cfg-render.ts` describeCfgRead): the settings listing as YAML, with its counts.
	const cfg = asRecord(details.cfg);
	const cfgPath = cfg ? (asString(cfg.path) ?? "") : cfgUrlPath(path);
	const isUrl = details.kind === "url";
	const suffixFrom = asString(details.suffixResolution?.from);
	const elidedSpans = asNumber(details.summary?.elidedSpans);
	const conflicts = asNumber(details.conflictCount) ?? 0;
	const truncation = metaTruncation(asRecord(details));
	const meta: string[] = [];
	if (cfg) {
		const count = asNumber(cfg.count) ?? 0;
		const modified = asNumber(cfg.modified) ?? 0;
		meta.push(t("tools.cfg.settings", { count, plural: count === 1 ? "" : "s" }));
		if (modified) meta.push(t("tools.cfg.modified", { count: modified }));
	}
	if (isUrl) {
		if (details.url && details.finalUrl && details.url !== details.finalUrl) {
			meta.push(t("tools.read.redirectedFrom", { host: urlHost(details.url) }));
		}
		if (details.contentType) meta.push(details.contentType);
		if (details.method) meta.push(details.method);
		for (const note of asArray(details.notes)) if (typeof note === "string" && note) meta.push(note);
	}
	if (suffixFrom) meta.push(t("tools.read.correctedFrom", { path: suffixFrom }));
	if (elidedSpans !== undefined) {
		meta.push(t("tools.read.summary", { count: elidedSpans, plural: elidedSpans === 1 ? "" : "s" }));
	}
	const HeadIcon = cfgPath !== null ? Settings2 : isUrl ? Globe : FileText;

	return (
		<div
			className={livePreview ? "omp-tool-editor omp-tool-read flex flex-col gap-1.5" : "flex flex-col gap-1.5"}
			// Live, the read text opens at its first line — the range start for a ranged read.
			data-live-focus={livePreview && head && !image && !isError ? "start" : undefined}
		>
			{!livePreview && (
				<div className="flex flex-col gap-0.5">
					<div className="flex items-center gap-1.5 font-mono text-omp-sm">
						<HeadIcon size={12} className="shrink-0 text-[var(--omp-dim)]" />
						{cfgPath !== null ? (
							<span className="min-w-0 truncate text-[var(--omp-muted)]">{cfgPath || t("tools.cfg.all")}</span>
						) : (
							<PathLink path={basePath} className="truncate">
								<ToolPathTarget path={basePath} />
							</PathLink>
						)}
						{conflicts > 0 && (
							<span className="shrink-0 text-sc-xs text-(--sc-warning)">
								{t("tools.read.conflicts", { count: conflicts, plural: conflicts === 1 ? "" : "s" })}
							</span>
						)}
					</div>
					{meta.length > 0 && (
						<div className="text-sc-xs text-(--sc-text-subtle)" data-read-meta>
							{meta.join(" · ")}
						</div>
					)}
				</div>
			)}
			{image ? (
				<ToolImage
					src={image.src}
					path={details.mediaPath ?? basePath}
					label={basename(path)}
					className={`${PREVIEW_HEIGHT_LG} rounded-md border border-[var(--omp-border-muted)] object-contain`}
				/>
			) : isError ? (
				<div
					className={`${PREVIEW_SCROLL_LG} whitespace-pre-wrap break-words rounded bg-[var(--omp-tool-error-bg)] px-2 py-1.5 font-mono text-omp-sm text-[var(--omp-error)]`}
				>
					{head || t("tools.read.empty")}
				</div>
			) : head ? (
				<>
					<CodeBlock
						code={head}
						language={cfgPath !== null ? "yaml" : languageFromPath(basePath)}
						showLanguage={false}
						showCopy={!livePreview}
						maxHeightClass={PREVIEW_HEIGHT_LG}
						startLine={display?.startLine ?? (livePreview ? 1 : undefined)}
						lineNumbers={display?.lineNumbers?.slice(0, head.split("\n").length)}
					/>
					{omitted > 0 && (
						<div className="text-center font-mono text-omp-xs text-[var(--omp-dim)]">
							{t("tools.read.more", { count: omitted, plural: omitted === 1 ? "" : "s" })}
						</div>
					)}
				</>
			) : (
				<div className="text-omp-sm italic text-[var(--omp-dim)]">
					{isPartial ? t("tools.read.reading") : t("tools.read.empty")}
				</div>
			)}
			{truncation ? (
				<TruncationNote notice={truncation} />
			) : isUrl && details.truncated === true ? (
				<div className="font-mono text-sc-xs text-(--sc-warning)">{t("tools.read.urlTruncated")}</div>
			) : null}
		</div>
	);
}
