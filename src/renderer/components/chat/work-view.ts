import type { AgentMessage, AgentProgress } from "../../../shared/rpc-types";
import { resultDetails } from "../../lib/format";
import type { SubagentNode } from "../../stores/subagents";
import type { ToolEntry } from "../../stores/tools";
import { toolDiffStats } from "../tools/diff-stats";
import { asPerFileResults } from "../tools/EditRenderer";
import { getToolHeader } from "../tools/index";
import { asRecord, normalizeYieldData } from "../tools/task-render-utils";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function workNarrative(
	tool: string,
	args: Record<string, unknown>,
	t: Translate,
	progress?: AgentProgress,
	wireIntent?: string,
): string {
	for (const intent of [wireIntent, args.intent, progress?.currentToolIntent, progress?.lastIntent, args.i]) {
		if (typeof intent === "string" && intent.trim()) return intent.trim();
	}
	const header = getToolHeader(tool, args);
	const taskNames =
		tool === "task" && Array.isArray(args.tasks)
			? args.tasks
					.flatMap(task =>
						task && typeof task === "object" && "name" in task && typeof task.name === "string"
							? [task.name]
							: [],
					)
					.join(", ")
			: "";
	return t("chat.work.activity", {
		tool: header.labelKey ? t(header.labelKey) : header.tool,
		target: header.path || header.target || taskNames || (typeof args.target === "string" ? args.target : ""),
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

/** Only a reply after this group's results, never a later turn's conclusion. */
export function workConclusion(
	messages: readonly AgentMessage[],
	liveMessages: readonly AgentMessage[],
	ownsCall: (id: string) => boolean,
): string {
	let matched = false;
	let conclusion = "";
	for (const source of [messages, liveMessages]) {
		for (const message of source) {
			if (message.role === "toolResult" && message.toolCallId && ownsCall(message.toolCallId)) {
				matched = true;
				conclusion = "";
			} else if (matched && message.role === "user") {
				return conclusion;
			} else if (matched && message.role === "assistant" && Array.isArray(message.content)) {
				if (message.content.some(block => block.type === "toolCall" && !ownsCall(block.id))) return conclusion;
				const text = message.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n");
				if (text.trim()) conclusion = replyHeadline(text);
			}
		}
	}
	return conclusion;
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

export function workOutcomes(entries: readonly WorkEvidence[], agents: readonly SubagentNode[] = []) {
	const files = new Map<string, { path: string; added?: number; removed?: number }>();
	const commands: Array<{
		command: string;
		exitCode: number | null;
		failed: boolean;
		agentName?: string;
		unknown?: boolean;
		durationMs?: number;
	}> = [];
	const conclusions: Array<{ name: string; summary: string }> = [];
	for (const evidence of entries) {
		const entry = "entry" in evidence ? evidence.entry : evidence;
		const agentName = "entry" in evidence ? evidence.agentName : undefined;
		if (
			entry.status === "running" ||
			entry.status === "pending" ||
			(entry.status === "aborted" && entry.toolName !== "bash")
		)
			continue;
		const details = resultDetails(entry.result);
		if (details?.source === "interrupt_skipped") continue;
		if (["write", "edit", "ast_edit", "apply_patch"].includes(entry.toolName) && !entry.isError) {
			const perFile = asPerFileResults(details?.perFileResults);
			const targets = perFile.length
				? perFile
						.filter(file => !file.isError)
						.map(file => ({
							path: file.move ?? file.path,
							stats: toolDiffStats("edit", { path: file.path }, { details: { diff: file.diff } }, false),
						}))
				: [
						{
							path: getToolHeader(entry.toolName, entry.args).path,
							stats: toolDiffStats(entry.toolName, entry.args, entry.result, false),
						},
					];
			for (const target of targets) {
				if (!target.path) continue;
				const existing = files.get(target.path);
				files.set(target.path, {
					path: target.path,
					added: target.stats ? (existing?.added ?? 0) + target.stats.added : existing?.added,
					removed: target.stats ? (existing?.removed ?? 0) + target.stats.removed : existing?.removed,
				});
			}
		}
		if (entry.toolName === "bash" && typeof entry.args.command === "string") {
			const exitCode = typeof details?.exitCode === "number" ? details.exitCode : null;
			commands.push({
				command: entry.args.command,
				exitCode,
				failed: entry.status !== "aborted" && entry.result != null && (entry.isError || entry.status === "error"),
				...(agentName ? { agentName } : {}),
				...(entry.status === "aborted" || entry.result == null ? { unknown: true } : {}),
				...(typeof details?.wallTimeMs === "number" ? { durationMs: details.wallTimeMs } : {}),
			});
		}
		if (entry.toolName === "task" && Array.isArray(details?.results)) {
			for (const result of details.results) {
				if (!result || typeof result !== "object") continue;
				const row = result as Record<string, unknown>;
				const summary = agentResultSummary(row);
				if (summary) conclusions.push({ name: String(row.name ?? row.id ?? row.agent ?? ""), summary });
			}
		}
	}
	// Detached stock tasks return before their final yields; progress carries the same result data.
	for (const agent of agents) {
		if (agent.status === "running" || agent.status === "pending") continue;
		const summary = agentResultSummary({ ...agent.progress });
		if (!summary) continue;
		const existing = conclusions.find(item => item.name === agent.id);
		if (existing) existing.summary = summary;
		else conclusions.push({ name: agent.id, summary });
	}
	return { files: [...files.values()], commands, conclusions };
}
