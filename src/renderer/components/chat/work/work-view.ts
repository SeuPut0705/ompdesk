import type { AgentProgress } from "../../../../shared/rpc-types";
import { TURN_EDIT_TOOLS } from "../../../../shared/turn-edits";
import { extractResultImages, resultDetails, resultText } from "../../../lib/format";
import { devServerUrl } from "../../../lib/panel-auto-open";
import { asRecord } from "../../../lib/wire-value";
import type { ToolEntry } from "../../../stores/tools";
import { toolDiffStats } from "../../tools/diff-stats";
import { workFilePathKey } from "../../tools/edit-args";
import { getToolHeader } from "../../tools/index";
import { type ChatMediaKind, toolResultMedia } from "../../tools/media/chat-media";
import { asPerFileResults } from "../../tools/renderers/EditRenderer";
import { normalizeYieldData } from "../../tools/renderers/task-render-utils";
import { type BackgroundJobVerdict, exitCodeOf } from "../completion-events";
import { isInterruptedError } from "./WorkStatus";
import { checkKind } from "./work-checks";

/** Enough of a check's output for its runner summary and first error line. */
const CHECK_TEXT_MAX = 8000;

// The error stock's bash throws for a command that ran and reported no exit, its details as empty as a refusal's
// (tools/bash.ts `#throwIfUnfinished`: "…Command failed: missing exit status"; `execute`'s cancelled branch: a leading
// "[Command cancelled]", a trailing "[Command aborted]", or "Command aborted" alone), a capture notice optionally after.
const RAN_WITHOUT_EXIT =
	/^\[Command cancelled\]|(?:^|\n\n)(?:Command failed: missing exit status|\[Command aborted\]|Command aborted)(?:\n\n\[[^\n]*\])?$/;

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** A model intent that names no target ("Running requested command") yields to the command itself. */
export const GENERIC_INTENT =
	/^(?:running|run|executing|execute)\s+(?:the\s+)?(?:requested|given|provided|specified|user(?:'s)?)?\s*(?:shell\s+|bash\s+)?commands?\.?$/i;

export function workNarrative(
	tool: string,
	args: Record<string, unknown>,
	t: Translate,
	progress?: AgentProgress,
	wireIntent?: string,
): string {
	for (const intent of [wireIntent, args.intent, progress?.currentToolIntent, progress?.lastIntent, args.i]) {
		if (typeof intent === "string" && intent.trim() && !GENERIC_INTENT.test(intent.trim())) return intent.trim();
	}
	if (tool === "task") {
		// Stock's task call is one spec (`name`, `agent`) or a batch (`tasks[]`); legacy specs carry a `description`.
		const specs = Array.isArray(args.tasks) ? args.tasks.map(asRecord) : [args];
		const names = [
			...new Set(
				specs.flatMap(spec => {
					const name = [spec?.name, spec?.description, spec?.agent].find(
						(value): value is string => typeof value === "string" && value.trim() !== "",
					);
					return name ? [name.trim()] : [];
				}),
			),
		];
		if (names.length === 0) return t("chat.work.runningSubagent");
		const shown = names.slice(0, 3).join(", ");
		return names.length > 3
			? t("chat.work.runningAgentsMore", { names: shown, count: names.length - 3 })
			: t("chat.work.runningAgents", { names: shown });
	}
	const header = getToolHeader(tool, args);
	const label = header.labelKey ? t(header.labelKey, header.labelParams) : header.tool;
	// Stock labels a cell by its title, else "running <language>" (eval.ts): "Run code js" named
	// the wire token, and "Run code Count rows" put a label before the title.
	if (tool === "eval") return header.target.trim() || label;
	return t("chat.work.activity", {
		tool: label,
		target: header.path || header.target || (typeof args.target === "string" ? args.target : ""),
	}).trim();
}

export function lastReasoningSentence(text: string): string {
	return (
		text
			.trim()
			.split(/(?<=[.!?。])\s+|\n+/)
			.filter(Boolean)
			.at(-1) ?? ""
	);
}

/**
 * The headline of a final reply: its first sentence as plain text. A reply's
 * opening states the result; its last sentence is often a caveat. Inline
 * markdown marks are dropped because the head renders plain text.
 */
export function replyHeadline(text: string): string {
	const plain = text
		.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/gm, "")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.trim();
	return (
		plain
			.split(/(?<=[.!?。])\s+|\n+/)
			.find(part => part.trim())
			?.trim() ?? ""
	);
}

export function isSkippedWork(entry: ToolEntry | undefined): boolean {
	return resultDetails(entry?.result)?.source === "interrupt_skipped";
}

/** Renderer-only excerpt of stock result/yield data, never a model-facing summary. */
export function agentResultSummary(row: Record<string, unknown>): string | null {
	const yields = normalizeYieldData(asRecord(row.extractedToolData)?.yield);
	const yieldedSummary = yields.map(item => asRecord(item.data)?.summary).findLast(value => typeof value === "string");
	let outputSummary: unknown;
	if (typeof row.output === "string" && row.output.trimStart().startsWith("{")) {
		try {
			outputSummary = asRecord(JSON.parse(row.output))?.summary;
		} catch {
			/* Plain prose remains evidence. */
		}
	}
	const summary = row.summary ?? yieldedSummary ?? outputSummary ?? row.output ?? row.error ?? row.stderr;
	return typeof summary === "string" ? summary.trim().split("\n")[0] || null : null;
}

/** `toolCallId`: the card's own entry key for a main-agent call, so a finding can point at its step. */
export type WorkEvidence = ToolEntry | { entry: ToolEntry; agentName?: string; toolCallId?: string };

/** Renderer-only, narrower counterpart of stock pi-coding-agent/src/tools/shell-tokenize.ts
 * tokenizeShellSegments / extractLiteralAndChainSegments: the renderer cannot
 * import stock. Accept only one literal rm/git rm, not a shell interpreter.
 * Never infer deletion from output, substrings, globs, variables, chains or --cached. */
function removedPaths(command: string): string[] {
	if (/[\\$`*?[\]{}();&|<>#~\n]/.test(command)) return [];
	const tokens = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g);
	if (!tokens || tokens.join(" ") !== command.trim().replace(/\s+/g, " ")) return [];
	const words = tokens.map(token => token.replace(/^(['"])(.*)\1$/, "$2"));
	const offset = words[0] === "rm" ? 1 : words[0] === "git" && words[1] === "rm" ? 2 : 0;
	if (!offset) return [];
	let operands = false;
	const paths: string[] = [];
	for (const word of words.slice(offset)) {
		if (!operands && word === "--") {
			operands = true;
			continue;
		}
		if (!operands && word.startsWith("-")) {
			if (!/^-f+$/.test(word) && word !== "--force") return [];
			continue;
		}
		operands = true;
		if (!word) return [];
		paths.push(word);
	}
	return paths;
}

/** One command a run ran, main agent or subagent. */
export interface WorkCommandOutcome {
	command: string;
	exitCode: number | null;
	failed: boolean;
	agentName?: string;
	unknown?: boolean;
	interrupted?: boolean;
	/**
	 * An error stock answered with no run to report: it refused the call before running the command (its arguments, a
	 * blocked command, a missing folder), or omp ended before the call returned (its card reads that one as interrupted,
	 * by the aborted reply after it). No exit report and none of the notices a command that ran without one ends with
	 * (`RAN_WITHOUT_EXIT`): it says nothing about the command, so it neither fails nor passes a check, and fixes nothing.
	 */
	refused?: true;
	durationMs?: number;
	/** What a stopped command printed before the stop, without stock's abort annotation. */
	output?: string;
	/** The tail of what a check (tests, build, lint) or a failed command printed, for `summarizeChecks`. */
	text?: string;
	/** The call's entry key (a main-agent call only). */
	toolCallId?: string;
	cwd?: string;
	/** When the call started and, once it answered, ended (the tool entry's clock). */
	startTime?: number;
	endTime?: number;
	/** Backgrounded: its outcome is the job's, whose failure the transcript also reports (`failedEvents`). */
	background?: true;
	/** The address a dev server printed, when this command started one. */
	previewUrl?: string;
}

export interface WorkFileOutcome {
	path: string;
	added?: number;
	removed?: number;
	deleted?: boolean;
}

/**
 * A picture in the outcome row. `src` is null when its bytes are unavailable;
 * `path` is the file it came from (empty when none), which the row opens instead.
 */
export interface WorkImageOutcome {
	key: string;
	src: string | null;
	path: string;
	/** The whole source (file path, page URL or the call's target), for the tooltip. */
	label: string;
	/** The short name under the thumbnail: a file's name, a page's host and path. */
	caption: string;
}

/** "https://example.com/workspace?x" → "example.com/workspace"; a path → its file name. */
function imageCaption(label: string): string {
	if (/^https?:\/\//i.test(label)) {
		try {
			const url = new URL(label);
			return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
		} catch {
			return label;
		}
	}
	return label.split(/[\\/]/).at(-1) ?? label;
}

/** An audio or video file the work wrote, recorded or read back; the row plays it in place. */
export interface WorkMediaOutcome {
	path: string;
	kind: ChatMediaKind;
}

export interface WorkOutcomes {
	files: WorkFileOutcome[];
	commands: WorkCommandOutcome[];
	images: WorkImageOutcome[];
	media: WorkMediaOutcome[];
}

/**
 * `stoppedAt`: the actual user-stop timestamp, used only for interrupted top-level calls.
 * Agent conclusions are not outcome rows: the run's lanes carry them (work-run.ts).
 */
export function workOutcomes(
	entries: readonly WorkEvidence[],
	stoppedAt?: number,
	cwd = "",
	jobVerdicts?: ReadonlyMap<string, BackgroundJobVerdict>,
): WorkOutcomes {
	const files = new Map<string, WorkFileOutcome>();
	// Stock write returns resolvedPath, not a diff or a creation flag. Its content
	// establishes the post-write line count; stock edit's diff/op then gives net
	// line deltas. Never cancel replacement lines for an ordinary pre-existing edit.
	const written = new Set<string>();
	const created = new Set<string>();
	const netLines = new Map<string, number>();
	const commands: WorkCommandOutcome[] = [];
	// Pictures the work produced or looked at (screenshots read back, browser captures, generated
	// images): the reply often talks about them, so the outcome shows them without opening steps.
	const images: WorkImageOutcome[] = [];
	const seenImages = new Set<string>();
	const media = new Map<string, WorkMediaOutcome>();
	for (const evidence of [...entries].sort((a, b) => {
		const left = "entry" in a ? a.entry : a;
		const right = "entry" in b ? b.entry : b;
		return left.startTime - right.startTime;
	})) {
		const entry = "entry" in evidence ? evidence.entry : evidence;
		const agentName = "entry" in evidence ? evidence.agentName : undefined;
		const toolCallId = "entry" in evidence && !agentName ? evidence.toolCallId : undefined;
		const fileKey = (path: string) => `${agentName ?? ""}\0${workFilePathKey(path, cwd)}`;
		if (
			entry.status === "running" ||
			entry.status === "pending" ||
			(entry.status === "aborted" && entry.toolName !== "bash")
		)
			continue;
		const details = resultDetails(entry.result);
		if (details?.source === "interrupt_skipped") continue;
		if (!entry.isError) {
			for (const image of extractResultImages(entry.result)) {
				if (seenImages.has(image.key)) continue;
				seenImages.add(image.key);
				const header = getToolHeader(entry.toolName, entry.args);
				// Stock's read names the file it showed in `details.mediaPath` (absolute); stock's browser
				// the page it captured in `details.url`, which says more than its action ("run").
				const path = typeof details?.mediaPath === "string" ? details.mediaPath : (header.path ?? "");
				const url = typeof details?.url === "string" ? details.url : "";
				const label = path || url || header.target || entry.toolName;
				images.push({ key: image.key, src: image.src, path, label, caption: imageCaption(label) });
			}
			for (const item of toolResultMedia(entry.toolName, entry.args, entry.result)) {
				const key = workFilePathKey(item.path, cwd);
				if (!media.has(key)) media.set(key, item);
			}
		}
		if (TURN_EDIT_TOOLS.includes(entry.toolName) && !entry.isError) {
			const perFile = asPerFileResults(details?.perFileResults);
			const targets = perFile.length
				? perFile
						.filter(file => !file.isError)
						.map(file => ({
							path: file.move ?? file.path,
							stats: toolDiffStats("edit", { path: file.path }, { details: { diff: file.diff } }, false),
							op: file.op,
							hasDiff: !!file.diff,
						}))
				: [
						{
							path:
								typeof details?.path === "string"
									? details.path
									: getToolHeader(entry.toolName, entry.args).path,
							stats: toolDiffStats(entry.toolName, entry.args, entry.result, false),
							op: details?.op,
							hasDiff: typeof details?.diff === "string" && !!details.diff,
						},
					];
			for (const target of targets) {
				if (!target.path) continue;
				const key = fileKey(target.path);
				const existing = files.get(key);
				if (target.op === "delete") {
					if (created.has(key)) files.delete(key);
					else files.set(key, { path: existing?.path ?? target.path, deleted: true });
					written.delete(key);
					created.delete(key);
					netLines.delete(key);
					continue;
				}
				const baseline = netLines.get(key);
				let added = target.stats ? (existing?.added ?? 0) + target.stats.added : existing?.added;
				let removed = target.stats ? (existing?.removed ?? 0) + target.stats.removed : existing?.removed;
				if (entry.toolName === "write" || target.op === "create") {
					written.add(key);
					if (target.op === "create") created.add(key);
					if (target.stats && target.stats.removed === 0) {
						netLines.set(key, target.stats.added);
						added = target.stats.added;
						removed = 0;
					} else netLines.delete(key);
				} else if (baseline !== undefined && target.hasDiff && target.stats) {
					const next = baseline + target.stats.added - target.stats.removed;
					if (target.stats.removed <= baseline && next >= 0) {
						netLines.set(key, next);
						added = next;
						removed = 0;
					} else netLines.delete(key);
				} else netLines.delete(key);
				files.set(key, { path: existing?.path ?? target.path, added, removed });
			}
		}
		if (entry.toolName === "bash" && typeof entry.args.command === "string") {
			// A backgrounded call's own result is only the notice; the delivered job is the outcome.
			const asyncJob = asRecord(details?.async);
			const backgroundId = asyncJob?.state === "running" && typeof asyncJob.jobId === "string" ? asyncJob.jobId : "";
			const verdict = backgroundId ? jobVerdicts?.get(backgroundId) : undefined;
			const pending = !!backgroundId && !verdict;
			const delivered = verdict ? (verdict.text.match(/<output>([\s\S]*?)<\/output>/)?.[1] ?? verdict.text) : "";
			const exitCode = verdict
				? (verdict.exitCode ?? exitCodeOf(delivered) ?? (verdict.failed ? null : 0))
				: typeof details?.exitCode === "number"
					? details.exitCode
					: null;
			const errored = verdict
				? verdict.failed
				: entry.status !== "aborted" && entry.result != null && (entry.isError || entry.status === "error");
			if (
				!errored &&
				entry.status === "done" &&
				entry.result != null &&
				(exitCode === null || exitCode === 0) &&
				!entry.args.cwd
			) {
				for (const path of removedPaths(entry.args.command)) {
					const key = fileKey(path);
					if (!written.has(key)) continue;
					if (created.has(key)) files.delete(key);
					else files.set(key, { path: files.get(key)?.path ?? path, deleted: true });
					written.delete(key);
					created.delete(key);
					netLines.delete(key);
				}
			}
			const cut = isInterruptedError(entry, agentName ? undefined : stoppedAt);
			const output = cut
				? resultText(entry.result)
						.replace(/\n*\[Command (?:aborted|cancelled)\]\s*$/, "")
						.trim()
				: "";
			// A command that ran reports its exit in the details (stock tools/bash.ts `#buildCompletedResult`: a failed exit's
			// code, a timeout) or, run without one, ends its error with stock's notice; an error with neither is a ToolError
			// stock threw before running the command.
			const refused =
				!verdict &&
				errored &&
				!cut &&
				typeof details?.exitCode !== "number" &&
				details?.timedOut !== true &&
				!RAN_WITHOUT_EXIT.test(resultText(entry.result).trim());
			const failed = errored && !cut && !refused;
			const text = verdict
				? failed || exitCode || checkKind(entry.args.command)
					? delivered.slice(-CHECK_TEXT_MAX)
					: ""
				: !cut &&
						!pending &&
						Array.isArray(asRecord(entry.result)?.content) &&
						(failed || exitCode || checkKind(entry.args.command))
					? resultText(entry.result).slice(-CHECK_TEXT_MAX)
					: "";
			const previewUrl =
				failed || pending || entry.status === "aborted" || entry.result == null
					? null
					: devServerUrl({ toolName: "bash", command: entry.args.command, text: resultText(entry.result) });
			commands.push({
				command: entry.args.command,
				exitCode,
				failed,
				...(agentName ? { agentName } : {}),
				...(pending || entry.status === "aborted" || entry.result == null ? { unknown: true } : {}),
				...(cut ? { interrupted: true } : {}),
				...(refused ? { refused: true as const } : {}),
				...(typeof details?.wallTimeMs === "number" ? { durationMs: details.wallTimeMs } : {}),
				...(output && output !== "Command aborted" ? { output } : {}),
				...(text ? { text } : {}),
				...(toolCallId ? { toolCallId } : {}),
				...(typeof entry.args.cwd === "string" && entry.args.cwd ? { cwd: entry.args.cwd } : {}),
				startTime: entry.startTime,
				...(entry.endTime !== null ? { endTime: entry.endTime } : {}),
				...(backgroundId ? { background: true as const } : {}),
				...(previewUrl ? { previewUrl } : {}),
			});
		}
	}
	return { files: [...files.values()], commands, images, media: [...media.values()] };
}
