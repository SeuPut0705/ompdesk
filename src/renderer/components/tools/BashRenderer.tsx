import { AnsiText, hasAnsi } from "../../lib/ansi";
import { cx, extractImageDataUrls, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_MD } from "../../lib/preview";
import { ResultImages } from "./ResultImages";
import { resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

/**
 * Bash wire shape: `{ content: [{ type: "text", text }], details }` where
 * `details` is `BashToolDetails` (packages/coding-agent/src/tools/bash.ts):
 *   { meta?: { truncation? }, timeoutSeconds?, requestedTimeoutSeconds?,
 *     timeoutDisabled?, wallTimeMs?, exitCode?, timedOut?, terminalId?,
 *     async?: { state, jobId } }
 * The text body carries the combined stdout/stderr stream plus LLM-facing
 * trailer notices (background / truncation / exit code / wall time / raw
 * artifact). Like the TUI, strip those notices and re-state them from
 * `details` as a stats line instead.
 */

/** Locale key + params for the truncation notice; the component translates it. */
interface TruncationNotice {
	key: string;
	params?: Record<string, number>;
}

interface BashParsed {
	output: string;
	exitCode: number | null;
	stats: string[];
	truncation: TruncationNotice | null;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Trailer notices the agent appends to the text body. Matched by anchored
 * regex rather than the exact mirror strings: the `details` block decides
 * WHETHER a notice exists (only strip when the wire carries the field), the
 * pattern tolerates rewording on the agent side. Wire append order (bash.ts
 * + enforceInlineByteCap + wrappedExecute): wall time first, then
 * intermediate notices (timeout clamp, pty, truncation), then the exit-code
 * line, then — when the inline byte cap spills — the
 * `[raw output: artifact://N]` footer, and finally wrappedExecute's
 * `[Showing …]` limit line OUTERMOST. Strip in reverse wire order so each
 * end-anchored match sees the real end of the text.
 */
const BACKGROUND_NOTICE_RE = /\n?Backgrounded as job [^\n]*; result will be delivered automatically\.\s*$/;
const EXIT_CODE_NOTICE_RE = /\n?Command exited with code -?\d+\s*$/;
const WALL_TIME_NOTICE_RE = /\n?Wall time: \d+(?:\.\d+)? seconds/;

function stripTrailer(text: string, re: RegExp): string {
	return text.replace(re, "").trimEnd();
}

/** Strip the LAST occurrence of a non-terminal notice (wall time). */
function stripLastOccurrence(text: string, re: RegExp): string {
	const matches = [...text.matchAll(new RegExp(re.source, "g"))];
	if (matches.length === 0) return text;
	const last = matches[matches.length - 1];
	const index = last.index ?? 0;
	return (text.slice(0, index) + text.slice(index + last[0].length)).trimEnd();
}

const RAW_ARTIFACT_RE = /\n?\[raw output: artifact:\/\/(\d+)\]\s*$/;
/** Trailing `[Showing …]` / limits notice line appended by wrappedExecute. */
const GENERATED_NOTICE_RE =
	/^\[(?:Showing .+|\d+ (?:matches|results) limit reached\. .+|Some lines truncated to .+)\]$/;

function stripGeneratedOutputNotice(text: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidate = trimmed.slice(lineStart === -1 ? 0 : lineStart + 1);
	if (!GENERATED_NOTICE_RE.test(candidate)) return text;
	return trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd();
}

function describeTruncation(truncation: Record<string, unknown>): TruncationNotice | null {
	const total = asNumber(truncation.totalLines);
	const count = asNumber(truncation.outputLines);
	const shownRange = truncation.shownRange as { start?: unknown; end?: unknown } | undefined;
	if (truncation.direction === "middle") {
		return total != null && count != null
			? { key: "tools.bash.truncation.middleCount", params: { count, total } }
			: { key: "tools.bash.truncation.middle" };
	}
	const start = asNumber(shownRange?.start);
	const end = asNumber(shownRange?.end);
	if (start != null && end != null && total != null) {
		return { key: "tools.bash.truncation.range", params: { start, end, total } };
	}
	if (count != null && total != null) return { key: "tools.bash.truncation.count", params: { count, total } };
	return null;
}

function parseBashResult(result: unknown, isError: boolean | undefined): BashParsed {
	const details = resultDetails(result);
	let text = resultText(result);

	const wallTimeMs = asNumber(details?.wallTimeMs);
	const exitCode = asNumber(details?.exitCode) ?? null;
	const timeoutSeconds = asNumber(details?.timeoutSeconds);
	const requestedTimeoutSeconds = asNumber(details?.requestedTimeoutSeconds);
	const timeoutDisabled = details?.timeoutDisabled === true;
	const asyncInfo =
		details?.async != null && typeof details.async === "object"
			? (details.async as { state?: unknown; jobId?: unknown })
			: undefined;
	const backgroundJobId = typeof asyncInfo?.jobId === "string" ? asyncInfo.jobId : undefined;
	const meta =
		details?.meta != null && typeof details.meta === "object" ? (details.meta as Record<string, unknown>) : undefined;
	const truncation =
		meta?.truncation != null && typeof meta.truncation === "object"
			? (meta.truncation as Record<string, unknown>)
			: undefined;

	// Strip trailer notices only when `details` confirms they were appended;
	// re-stated below from the structured fields instead. Reverse wire order:
	// wrappedExecute's notice, then the artifact footer, then the inner
	// background/exit/wall lines.
	if (meta) text = stripGeneratedOutputNotice(text);
	let artifactId =
		typeof details?.artifactId === "string"
			? details.artifactId
			: typeof truncation?.artifactId === "string"
				? truncation.artifactId
				: undefined;
	const artifactMatch = artifactId ? text.match(RAW_ARTIFACT_RE) : null;
	if (artifactMatch) {
		artifactId = artifactMatch[1];
		text = text.slice(0, artifactMatch.index).trimEnd();
	}
	if (asyncInfo?.state === "running" && backgroundJobId) {
		text = stripTrailer(text, BACKGROUND_NOTICE_RE);
	}
	if (exitCode != null) text = stripTrailer(text, EXIT_CODE_NOTICE_RE);
	if (wallTimeMs != null) text = stripLastOccurrence(text, WALL_TIME_NOTICE_RE);

	const stats: string[] = [];
	if (asyncInfo?.state === "running" && backgroundJobId) stats.push(`Backgrounded: ${backgroundJobId}`);
	if (wallTimeMs != null) stats.push(`Wall: ${(wallTimeMs / 1000).toFixed(2)}s`);
	if (timeoutDisabled) stats.push("Timeout: disabled");
	if (timeoutSeconds != null) {
		stats.push(
			requestedTimeoutSeconds != null && requestedTimeoutSeconds !== timeoutSeconds
				? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
				: `Timeout: ${timeoutSeconds}s`,
		);
	}
	if (artifactId) stats.push(`Artifact: ${artifactId}`);
	if (isError && exitCode != null) stats.push(`Exit: ${exitCode}`);

	return {
		output: text.trimEnd(),
		exitCode,
		stats,
		truncation: truncation ? describeTruncation(truncation) : null,
	};
}

/** Bash: command line, terminal-style output, exit-code badge, stats footer. */
export function BashRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const command = typeof args.command === "string" ? args.command : "";
	const effective = isPartial ? partialResult : result;
	const parsed = parseBashResult(effective, isError);
	const images = extractImageDataUrls(effective);
	const hasOutput = parsed.output.length > 0;

	return (
		<div className="flex flex-col gap-1.5">
			{/* One terminal surface: the command line, then its output under a hairline. */}
			<div className="omp-bash-terminal overflow-hidden rounded-(--sc-radius-md) bg-(--omp-code-bg) font-mono text-sc-sm">
				<div className="flex items-start gap-2 px-2.5 py-1.5 leading-normal">
					<span aria-hidden className="shrink-0 select-none text-(--sc-text-subtle)">
						$
					</span>
					<span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-(--sc-text)">{command}</span>
					{parsed.exitCode != null && (
						<span
							className={cx(
								"shrink-0 rounded-(--sc-radius-xs) px-1 text-sc-2xs font-medium tabular-nums",
								parsed.exitCode === 0 && !isError
									? "bg-(--sc-success)/15 text-(--sc-success)"
									: "bg-(--sc-danger)/15 text-(--sc-danger)",
							)}
						>
							{t("tools.bash.exit", { code: parsed.exitCode })}
						</span>
					)}
					{isPartial && parsed.exitCode == null && (
						<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("tools.bash.running")}</span>
					)}
				</div>
				{hasOutput && (
					<div
						className={cx(
							"border-t border-(--sc-divider) px-2.5 py-1.5 leading-normal text-(--omp-tool-output)",
							PREVIEW_SCROLL_MD,
						)}
					>
						<div className="whitespace-pre-wrap">
							{hasAnsi(parsed.output) ? <AnsiText text={parsed.output} /> : parsed.output}
						</div>
					</div>
				)}
			</div>
			<ResultImages images={images} />
			{parsed.stats.length > 0 && (
				<div className="font-mono text-sc-xs text-(--sc-text-subtle)">[{parsed.stats.join(" | ")}]</div>
			)}
			{parsed.truncation && (
				<div className="font-mono text-sc-xs text-(--sc-warning)">
					[{t(parsed.truncation.key, parsed.truncation.params)}]
				</div>
			)}
			{isError && !hasOutput && <div className="text-sc-sm text-(--sc-danger)">{t("tools.bash.failed")}</div>}
		</div>
	);
}
