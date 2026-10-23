import { FolderOpen } from "lucide-react";
import { cx, resultDetails, resultText } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { GLOB_PREVIEW_PATHS, PREVIEW_SCROLL_MD } from "../../../lib/preview";
import { asArray, asNumber, asRecord, asString } from "../../../lib/wire-value";
import { PathLink } from "../media/PathLink";
import type { ToolRendererProps } from "../ToolCard";

const MAX_PATHS = GLOB_PREVIEW_PATHS;

/**
 * Glob: matched-path count + the path list. Prefers the structured
 * `details.files` — parsing text lines miscounts appended notices (timeouts,
 * truncation notes) as paths and offers them as file links. Truncation,
 * timeout and skipped paths follow stock pi-tui `tools/glob.ts`
 * (`GlobToolDetails`): an empty timed-out scan is "incomplete", never "no
 * files", and a cut list names why (result limit, line/size limit).
 */
export function GlobRenderer({ args, result, isPartial, partialResult, livePreview }: ToolRendererProps) {
	const t = useT();
	const pattern = typeof args.path === "string" ? args.path : typeof args.pattern === "string" ? args.pattern : "";
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const listedPaths = Array.isArray(details?.files) ? details.files.map(String) : null;
	const totalCount = asNumber(details?.fileCount) ?? listedPaths?.length;
	const paths = (
		listedPaths ??
		resultText(effective)
			.split("\n")
			.map(l => l.trim())
			.filter(Boolean)
	).slice(0, MAX_PATHS);
	const truncation = asRecord(details?.truncation) ?? asRecord(asRecord(details?.meta)?.truncation);
	const resultLimit = asRecord(asRecord(asRecord(details?.meta)?.limits)?.resultLimit);
	const resultLimitReached = asNumber(details?.resultLimitReached);
	const truncated =
		details?.truncated === true || truncation != null || resultLimitReached != null || resultLimit != null;
	const timedOut = details?.timedOut === true;
	const reasons: string[] = [];
	if (resultLimitReached != null) reasons.push(t("tools.glob.limit", { count: resultLimitReached }));
	const reachedLimit = asNumber(resultLimit?.reached);
	if (reachedLimit != null) reasons.push(t("tools.glob.limit", { count: reachedLimit }));
	if (truncation)
		reasons.push(t(truncation.truncatedBy === "lines" ? "tools.glob.lineLimit" : "tools.glob.sizeLimit"));
	const artifactId = asString(truncation?.artifactId);
	if (artifactId) reasons.push(`artifact://${artifactId}`);
	const missingPaths = asArray(details?.missingPaths).filter((entry): entry is string => typeof entry === "string");
	const settled = !isPartial && details != null;
	const emptyIncomplete = settled && totalCount === 0 && (timedOut || truncated);
	const count = totalCount ?? paths.length;

	return (
		<div className={livePreview ? "omp-tool-results flex flex-col gap-1" : "flex flex-col gap-1"}>
			{!livePreview && (
				<div className="flex items-center gap-1.5 font-mono text-omp-sm">
					<FolderOpen size={12} className="shrink-0 text-[var(--omp-dim)]" />
					<span className="truncate text-[var(--omp-text)]">{pattern}</span>
					<span className="ml-auto flex shrink-0 items-center gap-1.5 text-omp-xs text-[var(--omp-dim)]">
						{settled && (truncated || timedOut) && (
							<span className="text-[var(--omp-warning)]">
								{t(timedOut ? "tools.glob.timedOut" : "tools.grep.truncated")}
							</span>
						)}
						<span>{isPartial ? t("tools.glob.matching") : t("tools.glob.paths", { count })}</span>
					</span>
				</div>
			)}
			{paths.length > 0 && (
				<div
					className={cx(
						"rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-omp-sm leading-[1.5]",
						PREVIEW_SCROLL_MD,
					)}
				>
					{paths.map((p, i) => (
						<PathLink
							key={i}
							path={p.endsWith("/") ? p.slice(0, -1) : p}
							className="block truncate whitespace-pre text-[var(--omp-muted)] transition-colors hover:bg-[var(--omp-selected-bg)]/50"
						>
							{p.endsWith("/") ? <span className="text-[var(--omp-status-path)]">{p}</span> : p}
						</PathLink>
					))}
				</div>
			)}
			{emptyIncomplete && <div className="text-sc-sm text-(--sc-warning)">{t("tools.glob.incomplete")}</div>}
			{settled && reasons.length > 0 && !emptyIncomplete && (
				<div className="text-sc-xs text-(--sc-warning)">
					{t("tools.glob.truncatedBy", { reasons: reasons.join(", ") })}
				</div>
			)}
			{settled && missingPaths.length > 0 && (
				<div className="text-sc-xs text-(--sc-warning)">
					{t("tools.search.missingPaths", { paths: missingPaths.join(", ") })}
				</div>
			)}
			{livePreview && paths.length === 0 && !emptyIncomplete && (
				<div className="text-sc-sm text-(--sc-text-muted)">
					{isPartial ? t("tools.glob.matching") : t("tools.grep.noMatches")}
				</div>
			)}
		</div>
	);
}
