import { AnsiText, hasAnsi } from "../../lib/ansi";
import { cx, extractImageDataUrls, formatDuration, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_MD } from "../../lib/preview";
import { detectLocalPreviewUrls } from "../../lib/preview-browser";
import { useUiStore } from "../../stores/ui";
import { ResultImages } from "./ResultImages";
import { resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

function BashOutput({ text }: { text: string }) {
	const openPreview = useUiStore(s => s.openPreview);
	if (hasAnsi(text)) {
		const urls = detectLocalPreviewUrls(text);
		return (
			<span
				onClickCapture={event => {
					const anchor = event.target instanceof Element ? event.target.closest("a") : null;
					const url = anchor?.getAttribute("href");
					if (!url || !detectLocalPreviewUrls(url).length) return;
					event.preventDefault();
					event.stopPropagation();
					openPreview(url);
				}}
			>
				<AnsiText text={text} />
				{urls.map(url => (
					<a
						key={url}
						href={url}
						className="mt-1 block underline underline-offset-2"
						onClick={event => {
							event.preventDefault();
							openPreview(url);
						}}
					>
						{url}
					</a>
				))}
			</span>
		);
	}
	return text.split(/(https?:\/\/[^\s<>\x1b"'`]+)/g).map((part, index) => {
		const url = detectLocalPreviewUrls(part)[0];
		if (!url) return part;
		return (
			<a
				key={index}
				href={url}
				className="underline underline-offset-2 focus-visible:outline focus-visible:outline-(--sc-focus-ring)"
				onClick={event => {
					event.preventDefault();
					openPreview(url);
				}}
			>
				{part}
			</a>
		);
	});
}
/**
 * Bash wire shape: `{ content: [{ type: "text", text }], details }` where
 * `details` is `BashToolDetails` (packages/coding-agent/src/tools/bash.ts):
 *   { meta?: { truncation? }, timeoutSeconds?, requestedTimeoutSeconds?,
 *     timeoutDisabled?, wallTimeMs?, exitCode?, timedOut?, terminalId?,
 *     async?: { state, jobId } }
 * The text body carries the combined stdout/stderr stream plus LLM-facing
 * trailer notices (background / timeout / truncation / exit code / wall time /
 * raw artifact). Strip those notices and re-state them from `details`: exit,
 * elapsed and timeout as badges on the command line, the rest as a quiet note.
 */

/** Locale key + params for the truncation notice; the component translates it. */
interface TruncationNotice {
	key: string;
	params?: Record<string, number>;
}

interface BashParsed {
	output: string;
	exitCode: number | null;
	/** Stock's measured wall time; shown as the elapsed badge beside the command. */
	wallTimeMs: number | null;
	timedOut: boolean;
	backgrounded: string | null;
	clamped: { timeout: number; requested: number } | null;
	artifactId: string | null;
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
const TIMED_OUT_NOTICE_RE = /\n?\[Command timed out(?: after \d+ seconds)?\]\s*$/;
const TIMEOUT_CLAMP_NOTICE_RE = /\n?Timeout clamped to \d+s \(requested \d+s; [^)\n]*\)\./;
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

function parseBashResult(result: unknown): BashParsed {
	const details = resultDetails(result);
	let text = resultText(result);

	const wallTimeMs = asNumber(details?.wallTimeMs);
	const exitCode = asNumber(details?.exitCode) ?? null;
	const timedOut = details?.timedOut === true;
	const timeoutSeconds = asNumber(details?.timeoutSeconds);
	const requestedTimeoutSeconds = asNumber(details?.requestedTimeoutSeconds);
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
	// timeout/background/exit/clamp/wall lines.
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
	if (timedOut) text = stripTrailer(text, TIMED_OUT_NOTICE_RE);
	const backgrounded = asyncInfo?.state === "running" && backgroundJobId ? backgroundJobId : null;
	if (backgrounded) text = stripTrailer(text, BACKGROUND_NOTICE_RE);
	if (exitCode != null) text = stripTrailer(text, EXIT_CODE_NOTICE_RE);
	const clamped =
		timeoutSeconds != null && requestedTimeoutSeconds != null && requestedTimeoutSeconds !== timeoutSeconds
			? { timeout: timeoutSeconds, requested: requestedTimeoutSeconds }
			: null;
	if (clamped) text = stripLastOccurrence(text, TIMEOUT_CLAMP_NOTICE_RE);
	if (wallTimeMs != null) text = stripLastOccurrence(text, WALL_TIME_NOTICE_RE);

	return {
		output: text.trimEnd(),
		exitCode,
		wallTimeMs: wallTimeMs ?? null,
		timedOut,
		backgrounded,
		clamped,
		artifactId: artifactId ?? null,
		truncation: truncation ? describeTruncation(truncation) : null,
	};
}

/** Bash: command line with exit/elapsed badges, terminal-style output, then any job/artifact note. */
export function BashRenderer({ args, result, isError, isPartial, partialResult, livePreview }: ToolRendererProps) {
	const t = useT();
	const command = typeof args.command === "string" ? args.command : "";
	const effective = isPartial ? partialResult : result;
	const parsed = parseBashResult(effective);
	const notes = [
		parsed.backgrounded ? t("tools.bash.background", { id: parsed.backgrounded }) : null,
		parsed.clamped ? t("tools.bash.timeoutClamped", parsed.clamped) : null,
		parsed.artifactId ? t("tools.bash.artifact", { id: parsed.artifactId }) : null,
	].filter(note => note !== null);
	const images = extractImageDataUrls(effective);
	const hasOutput = parsed.output.length > 0;
	const echo = `${command}\n`;
	const promptEcho = `$ ${command}\n`;
	const liveOutput =
		livePreview && parsed.output.startsWith(echo)
			? parsed.output.slice(echo.length)
			: livePreview && parsed.output.startsWith(promptEcho)
				? parsed.output.slice(promptEcho.length)
				: parsed.output;
	const outputLines = livePreview ? liveOutput.split("\n") : null;

	return (
		<div className="flex flex-col gap-1.5">
			{/* One terminal surface: the command line, then its output under a hairline. */}
			<div
				className={cx(
					"omp-bash-terminal rounded-(--sc-radius-md) bg-(--omp-code-bg) font-mono text-sc-sm",
					// `clip`, not `hidden`: the live command line sticks to the scrolling surface above it.
					livePreview ? "omp-bash-live overflow-clip" : "overflow-hidden",
				)}
			>
				{/* A call whose arguments are still streaming has no command yet: no bare `$`. */}
				{command ? (
					<div className="omp-bash-prompt flex items-start gap-2 px-2.5 py-1.5 leading-normal">
						<span aria-hidden className="shrink-0 select-none text-(--sc-text-subtle)">
							$
						</span>
						<span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-(--sc-text)">{command}</span>
						{parsed.timedOut && (
							<span className="omp-bash-badge shrink-0 rounded-(--sc-radius-xs) bg-(--sc-warning)/15 px-1 text-sc-2xs font-medium text-(--sc-warning)">
								{t("tools.bash.timedOut")}
							</span>
						)}
						{parsed.exitCode != null && (
							<span
								className={cx(
									"omp-bash-badge shrink-0 rounded-(--sc-radius-xs) px-1 text-sc-2xs font-medium tabular-nums",
									parsed.exitCode === 0 && !isError
										? "bg-(--sc-success)/15 text-(--sc-success)"
										: "bg-(--sc-danger)/15 text-(--sc-danger)",
								)}
							>
								{t("tools.bash.exit", { code: parsed.exitCode })}
							</span>
						)}
						{parsed.wallTimeMs != null && (
							<span
								className="omp-bash-elapsed shrink-0 text-sc-2xs tabular-nums text-(--sc-text-subtle)"
								title={t("tools.bash.wallTime")}
							>
								{formatDuration(parsed.wallTimeMs)}
							</span>
						)}
						{isPartial && parsed.exitCode == null && parsed.wallTimeMs == null && (
							<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("tools.bash.running")}</span>
						)}
					</div>
				) : null}
				{(hasOutput || livePreview) && (
					<div
						className={cx(
							"px-2.5 py-1.5 leading-normal text-(--omp-tool-output)",
							command && "border-t border-(--sc-divider)",
							PREVIEW_SCROLL_MD,
						)}
					>
						<div className="whitespace-pre-wrap">
							{outputLines ? (
								outputLines.map((line, index) => (
									<span className="omp-bash-line" key={index}>
										<BashOutput text={line} />
									</span>
								))
							) : (
								<BashOutput text={parsed.output} />
							)}
						</div>
					</div>
				)}
			</div>
			<ResultImages images={images} livePreview={livePreview} />
			{notes.length > 0 && (
				<div className="omp-bash-notes text-sc-xs text-(--sc-text-subtle)">{notes.join(" · ")}</div>
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
