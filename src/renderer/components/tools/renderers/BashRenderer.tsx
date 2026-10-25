import { AppWindow } from "lucide-react";
import { memo, useState } from "react";
import { AnsiText, hasAnsi } from "../../../lib/ansi";
import { cx, extractImageDataUrls, formatDuration, resultText } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { devServerUrl } from "../../../lib/panel-auto-open";
import { PREVIEW_SCROLL_MD } from "../../../lib/preview";
import { detectLocalPreviewUrls } from "../../../lib/preview-browser";
import { useUiStore } from "../../../stores/ui";
import { LinkButton } from "../../common";
import { ResultImages } from "../media/ResultImages";
import type { ToolRendererProps } from "../ToolCard";
import { describeTruncation, stripGeneratedOutputNotice, TruncationNote, type TruncationNotice } from "./output-meta";
import { resultDetails } from "./result";

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
 * One live terminal line. Lines that did not change skip rendering while output streams in,
 * and only a line that arrived while the surface was on screen plays the arrival mark: a
 * surface mounting with a long log already in it (a tab switch, a lane taking the stage)
 * would otherwise start one animation per line.
 */
const LiveLine = memo(function LiveLine({ text, arrived }: { text: string; arrived: boolean }) {
	return (
		<span className="omp-bash-line" data-arrived={arrived || undefined}>
			<BashOutput text={text} />
		</span>
	);
});
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
const EXIT_CODE_NOTICE_RE = /\n?Command exited with code -?\d+\s*$/;
const TIMED_OUT_NOTICE_RE = /\n?\[Command timed out(?: after \d+ seconds)?\]\s*$/;
const TIMEOUT_CLAMP_NOTICE_RE = /\n?Timeout clamped to \d+s \(requested \d+s; [^)\n]*\)\./;
const WALL_TIME_NOTICE_RE = /\n?Wall time: \d+(?:\.\d+)? seconds/;

function stripTrailer(text: string, re: RegExp): string {
	return text.replace(re, "").trimEnd();
}

/**
 * Stock's background-job footer is one line starting `Backgrounded as job <id>` then `;` or a
 * space (its deadline), in every wording stock has used. A renderer copy of pi-tui tools/bash.ts
 * `stripTrailingNotice(text, line => isBackgroundNotice(line, jobId))`: `isBackgroundNotice` is
 * not exported and the renderer cannot import stock. bash-notice-stock.test.ts pins it to every
 * notice stock's `formatBackgroundNotice` writes.
 */
export function stripBackgroundNotice(text: string, jobId: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n") + 1;
	const prefix = `Backgrounded as job ${jobId}`;
	const next = trimmed[lineStart + prefix.length];
	return trimmed.startsWith(prefix, lineStart) && (next === ";" || next === " ")
		? trimmed.slice(0, lineStart).trimEnd()
		: text;
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
	if (backgrounded) text = stripBackgroundNotice(text, backgrounded);
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

/**
 * What a command printed, as the live stage shows it: without the command line a shell echoed
 * first and without stock's "(no output)" stand-in for a command that printed nothing (bash.ts).
 */
function liveOutputOf(command: string, output: string): string {
	const echo = [`${command}\n`, `$ ${command}\n`].find(prefix => output.startsWith(prefix));
	const shown = echo ? output.slice(echo.length) : output;
	return shown === "(no output)" ? "" : shown;
}

/** A command that has printed nothing (yet): the live stage shows its command line alone. */
export function isSilentCommand(args: Record<string, unknown>, result: unknown): boolean {
	const command = typeof args.command === "string" ? args.command : "";
	return (
		command !== "" &&
		liveOutputOf(command, parseBashResult(result).output) === "" &&
		extractImageDataUrls(result).length === 0
	);
}

/**
 * Bash: command line with exit and elapsed badges, terminal-style output, then any job/artifact note. Under a row
 * that shows the whole command (`rowShowsTarget`) the command line keeps only its badges; the elapsed badge stays,
 * since it is the command's own wall time and the row's time also counts the model's turn before it.
 */
export function BashRenderer({
	args,
	result,
	isError,
	isPartial,
	partialResult,
	livePreview,
	rowShowsTarget,
}: ToolRendererProps) {
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
	const liveOutput = livePreview ? liveOutputOf(command, parsed.output) : parsed.output;
	// A server the command started: offered as a quiet link, never opened by itself (panel-auto-open.ts is opt-in).
	const devServer = devServerUrl({ toolName: "bash", command, text: parsed.output });
	// Nothing printed yet: the live stage shows the command line alone, never an empty terminal.
	const silent = !!livePreview && command !== "" && liveOutput === "" && images.length === 0;
	const outputLines = livePreview ? liveOutput.split("\n") : null;
	// Lines complete when the surface mounted; the open last line still counts as arriving.
	const [settledLines] = useState(() => (outputLines?.length ?? 1) - 1);
	const running = isPartial && parsed.exitCode == null && parsed.wallTimeMs == null;
	// The row says a one-line command: the prompt line then stays only for its badges.
	const rowShowsCommand = rowShowsTarget === true && !command.trim().includes("\n");
	const prompt =
		command !== "" &&
		(!rowShowsCommand || parsed.timedOut || parsed.exitCode != null || parsed.wallTimeMs != null || running);
	// A finished command that printed nothing and whose row already says it would open to nothing.
	const nothing =
		!prompt && !hasOutput && !livePreview && !isPartial && !isError && images.length === 0 && notes.length === 0;

	return (
		<div className="flex flex-col gap-1.5">
			{/* One terminal surface: the command line, then its output under a hairline. */}
			<div
				className={cx(
					"omp-bash-terminal rounded-(--sc-radius-md) bg-(--omp-code-bg) font-mono text-sc-sm",
					// `clip`, not `hidden`: the live command line sticks to the scrolling surface above it.
					livePreview ? "omp-bash-live overflow-clip" : "overflow-hidden",
				)}
				data-silent={silent || undefined}
			>
				{/* A call whose arguments are still streaming has no command yet: no bare `$`. */}
				{prompt ? (
					<div className="omp-bash-prompt flex items-start gap-2 px-2.5 py-1.5 leading-normal">
						{rowShowsCommand ? null : (
							<>
								<span aria-hidden className="shrink-0 select-none text-(--sc-text-subtle)">
									$
								</span>
								<span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-(--sc-text)">{command}</span>
							</>
						)}
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
						{running && (
							<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("tools.bash.running")}</span>
						)}
					</div>
				) : null}
				{(hasOutput || livePreview) && !silent && (
					<div
						className={cx(
							"px-2.5 py-1.5 leading-normal text-(--omp-tool-output)",
							prompt && "border-t border-(--sc-divider)",
							PREVIEW_SCROLL_MD,
						)}
					>
						<div className="whitespace-pre-wrap">
							{outputLines ? (
								outputLines.map((line, index) => (
									<LiveLine key={index} text={line} arrived={index >= settledLines} />
								))
							) : (
								<BashOutput text={parsed.output} />
							)}
						</div>
					</div>
				)}
				{nothing ? (
					<div className="px-2.5 py-1.5 leading-normal text-(--sc-text-muted)">{t("chat.exec.noOutput")}</div>
				) : null}
			</div>
			{devServer && !isPartial && (
				<LinkButton
					className="omp-bash-open-preview inline-flex w-fit items-center gap-1 text-sc-xs"
					data-bash-open-preview
					onClick={() => useUiStore.getState().openPreview(devServer)}
					title={devServer}
				>
					<AppWindow aria-hidden size={12} />
					{t("tools.bash.openPreview")}
				</LinkButton>
			)}
			<ResultImages images={images} livePreview={livePreview} />
			{notes.length > 0 && (
				<div className="omp-bash-notes text-sc-xs text-(--sc-text-subtle)">{notes.join(" · ")}</div>
			)}
			{parsed.truncation && <TruncationNote notice={parsed.truncation} />}
			{isError && !hasOutput && <div className="text-sc-sm text-(--sc-danger)">{t("tools.bash.failed")}</div>}
		</div>
	);
}
