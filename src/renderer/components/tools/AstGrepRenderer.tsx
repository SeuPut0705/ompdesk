import { Braces } from "lucide-react";
import { resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_MD } from "../../lib/preview";
import { asNumber, asString } from "../../lib/wire-value";
import { Chip, ParseIssues } from "./AstEditRenderer";
import { countMatches, GroupedMatchList, parseDisplayGroups } from "./GrepRenderer";
import type { ToolRendererProps } from "./ToolCard";
import { ToolTextPreview } from "./ToolTextPreview";

/**
 * AST grep, after stock pi-tui `tools/ast-grep.ts`: the pattern, then
 * `N matches · N files · in scope · searched N` (limit reached in warning),
 * the grouped matches from `details.displayContent` with their metavariable
 * bindings, the limit note, and parse issues — which, on an empty result,
 * warn that the query may be mis-scoped. `details` is `AstGrepToolDetails`.
 */
export function AstGrepRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.pat === "string" ? args.pat : "";
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const text = resultText(effective);
	const display = asString(details?.displayContent) ?? text;
	const groups = isError || details == null ? [] : parseDisplayGroups(display, undefined);
	const matchCount = asNumber(details?.matchCount) ?? countMatches(groups);
	const fileCount = asNumber(details?.fileCount) ?? groups.length;
	const filesSearched = asNumber(details?.filesSearched) ?? 0;
	const limitReached = details?.limitReached === true;
	const scope = asString(details?.scopePath);
	const hasParseErrors = Array.isArray(details?.parseErrors) && details.parseErrors.length > 0;
	const settled = details != null && !isPartial && !isError;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<Braces size={12} className="shrink-0 text-[var(--omp-md-code)]" />
				<span className="min-w-0 flex-1 truncate text-[var(--omp-text)]" title={pattern || undefined}>
					{pattern.replace(/\s+/g, " ").trim() || t("tools.astgrep.fallback")}
				</span>
			</div>
			{settled && (
				<div className="flex flex-wrap items-center gap-1">
					<Chip>{t("tools.grep.matches", { count: matchCount, plural: matchCount === 1 ? "" : "es" })}</Chip>
					<Chip>{t("tools.grep.files", { count: fileCount, plural: fileCount === 1 ? "" : "s" })}</Chip>
					{scope && <Chip title={scope}>{t("tools.astedit.scope", { path: scope })}</Chip>}
					{filesSearched > 0 && <Chip>{t("tools.astedit.searched", { count: filesSearched })}</Chip>}
					{limitReached && <Chip warning>{t("tools.astedit.limitChip")}</Chip>}
				</div>
			)}
			{settled && matchCount > 0 && <GroupedMatchList groups={groups} matchCount={matchCount} />}
			{settled && limitReached && (
				<div className="text-omp-sm text-[var(--omp-warning)]">{t("tools.astgrep.limitReached")}</div>
			)}
			{settled && matchCount === 0 && (
				<div className="text-omp-sm italic text-[var(--omp-dim)]">{t("tools.astgrep.noMatches")}</div>
			)}
			{settled && matchCount === 0 && hasParseErrors && (
				<div className="text-omp-sm text-[var(--omp-warning)]">{t("tools.astgrep.misScoped")}</div>
			)}
			{settled && <ParseIssues details={details} />}
			{isPartial && <div className="text-omp-sm italic text-[var(--omp-dim)]">{t("tools.astgrep.matching")}</div>}
			{!isPartial && (isError || details == null) && (
				// Errors, and history without details: the result text as it came.
				<ToolTextPreview
					isError={isError}
					scrollClass={PREVIEW_SCROLL_MD}
					text={text || t("tools.astgrep.noMatches")}
				/>
			)}
		</div>
	);
}
