import type { AgentProgress } from "../../../shared/rpc-types";
import { extractImageDataUrls, resultDetails, resultText } from "../../lib/format";
import { asRecord } from "../../lib/wire-value";
import type { ToolEntry } from "../../stores/tools";
import { toolDiffStats } from "../tools/diff-stats";
import { asPerFileResults } from "../tools/EditRenderer";
import { workFilePathKey } from "../tools/edit-args";
import { getToolHeader } from "../tools/index";
import { normalizeYieldData } from "../tools/task-render-utils";
import { isInterruptedError } from "./WorkStatus";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** A model intent that names no target ("Running requested command") yields to the command itself. */
const GENERIC_INTENT =
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
	return t("chat.work.activity", {
		tool: header.labelKey ? t(header.labelKey) : header.tool,
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

export type WorkEvidence = ToolEntry | { entry: ToolEntry; agentName: string };

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
	durationMs?: number;
	/** What a stopped command printed before the stop, without stock's abort annotation. */
	output?: string;
}

export interface WorkFileOutcome {
	path: string;
	added?: number;
	removed?: number;
	deleted?: boolean;
}

export interface WorkOutcomes {
	files: WorkFileOutcome[];
	commands: WorkCommandOutcome[];
	images: Array<{ src: string; label: string }>;
}

/**
 * `stoppedAt`: the actual user-stop timestamp, used only for interrupted top-level calls.
 * Agent conclusions are not outcome rows: the run's lanes carry them (work-run.ts).
 */
export function workOutcomes(entries: readonly WorkEvidence[], stoppedAt?: number, cwd = ""): WorkOutcomes {
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
	const images: Array<{ src: string; label: string }> = [];
	const seenImages = new Set<string>();
	for (const evidence of [...entries].sort((a, b) => {
		const left = "entry" in a ? a.entry : a;
		const right = "entry" in b ? b.entry : b;
		return left.startTime - right.startTime;
	})) {
		const entry = "entry" in evidence ? evidence.entry : evidence;
		const agentName = "entry" in evidence ? evidence.agentName : undefined;
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
			for (const src of extractImageDataUrls(entry.result)) {
				if (seenImages.has(src)) continue;
				seenImages.add(src);
				const header = getToolHeader(entry.toolName, entry.args);
				images.push({ src, label: header.path || header.target || entry.toolName });
			}
		}
		if (["write", "edit", "ast_edit", "apply_patch"].includes(entry.toolName) && !entry.isError) {
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
			const exitCode = typeof details?.exitCode === "number" ? details.exitCode : null;
			const errored =
				entry.status !== "aborted" && entry.result != null && (entry.isError || entry.status === "error");
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
			commands.push({
				command: entry.args.command,
				exitCode,
				failed: errored && !cut,
				...(agentName ? { agentName } : {}),
				...(entry.status === "aborted" || entry.result == null ? { unknown: true } : {}),
				...(cut ? { interrupted: true } : {}),
				...(typeof details?.wallTimeMs === "number" ? { durationMs: details.wallTimeMs } : {}),
				...(output && output !== "Command aborted" ? { output } : {}),
			});
		}
	}
	return { files: [...files.values()], commands, images };
}
