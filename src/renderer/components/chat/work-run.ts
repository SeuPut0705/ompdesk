import type { AgentMessage } from "../../../shared/rpc-types";
import { resultDetails, resultText } from "../../lib/format";
import { asRecord } from "../../lib/wire-value";
import type { SubagentNode } from "../../stores/subagents";
import type { TodoSnapshot } from "../../stores/todo";
import type { ToolEntry } from "../../stores/tools";
import { workFilePathKey } from "../tools/edit-args";
import { messageSourceTimestamp } from "./work-turn";
import { agentResultSummary, replyHeadline } from "./work-view";

/**
 * One run's agent story, read from stock's own records so a live card and a
 * reloaded one say the same thing. Stock 18.10 settles a subagent through
 * `<task-result>` envelopes (task tool result for blocking spawns, `async-result`
 * follow-ups and `wait` results for detached ones) and through the finished
 * progress snapshot; registry rows for finished agents are gone after a reload.
 */
export interface AgentCompletion {
	status?: "completed" | "failed" | "aborted";
	/** First line of the agent's own final message (or its error), never an assignment. */
	summary?: string;
	/** Stock's settled wall time: SingleResult.durationMs or the async job's span. */
	durationMs?: number;
}

export interface RunTranscript {
	/** Agents spawned by this run's task calls, as stock's task result recorded them. */
	agents: SubagentNode[];
	completions: ReadonlyMap<string, AgentCompletion>;
}

const ENVELOPE = /<task-result\b([^>]*)>([\s\S]*?)<\/task-result>/g;

function attribute(attributes: string, name: string): string | undefined {
	return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1];
}

function tagBody(body: string, tag: string): string | undefined {
	return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(body)?.[1]?.trim();
}

/** Stock result-summary.ts status words: completed, cancelled, failed (exit N), merge failed. */
function envelopeStatus(status: string | undefined): AgentCompletion["status"] {
	if (!status) return undefined;
	if (status === "completed") return "completed";
	if (status === "cancelled") return "aborted";
	return status.includes("failed") ? "failed" : undefined;
}

/** A settled agent's one-line conclusion from its final text: a JSON `summary`, else the first sentence. */
export function completionHeadline(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	// Stock's formatResultOutputFallback placeholder is not something the agent said.
	if (!trimmed || /^\(no output\)/.test(trimmed)) return undefined;
	if (trimmed.startsWith("{")) {
		const summary = agentResultSummary({ output: trimmed });
		if (summary && !summary.startsWith("{")) return summary;
	}
	return replyHeadline(trimmed) || undefined;
}

/** Every `<task-result>` envelope stock rendered into a tool result or completion notice. */
export function parseTaskResults(text: string): Array<{ id: string } & AgentCompletion> {
	const results: Array<{ id: string } & AgentCompletion> = [];
	for (const match of text.matchAll(ENVELOPE)) {
		const attributes = match[1] ?? "";
		const body = match[2] ?? "";
		const id = attribute(attributes, "id");
		if (!id) continue;
		const status = envelopeStatus(attribute(attributes, "status"));
		const output = tagBody(body, "output") ?? tagBody(body, "preview");
		const summary =
			status === "failed"
				? (completionHeadline(tagBody(body, "error")) ?? completionHeadline(output))
				: completionHeadline(output);
		results.push({ id, ...(status ? { status } : {}), ...(summary ? { summary } : {}) });
	}
	return results;
}

function singleResultCompletion(row: Record<string, unknown>): AgentCompletion {
	const status: AgentCompletion["status"] =
		row.aborted === true ? "aborted" : row.exitCode === 0 ? "completed" : "failed";
	const output = typeof row.output === "string" ? row.output : undefined;
	const yielded = agentResultSummary({ extractedToolData: row.extractedToolData });
	const summary =
		completionHeadline(yielded ?? undefined) ??
		(status === "failed"
			? (completionHeadline(typeof row.error === "string" ? row.error : undefined) ?? completionHeadline(output))
			: completionHeadline(output));
	return {
		status,
		...(summary ? { summary } : {}),
		...(typeof row.durationMs === "number" ? { durationMs: row.durationMs } : {}),
	};
}

/** A finished task call of this run as the tools store holds it (live or hydrated). */
export interface TaskCallResult {
	toolCallId: string;
	result: unknown;
	timestamp: number;
}

/**
 * Agents and their completions for the task calls this run owns. Completions
 * may land after the run's reply (a detached agent finishing in a follow-up
 * turn), so the scan runs to the end of the transcript; the first settlement
 * of an agent id after its spawn wins.
 */
export function runTranscript(
	messages: readonly AgentMessage[],
	ownsCall: (id: string) => boolean,
	taskCalls: readonly TaskCallResult[] = [],
): RunTranscript {
	const agents = new Map<string, SubagentNode>();
	const completions = new Map<string, AgentCompletion>();
	const settle = (id: string, completion: AgentCompletion) => {
		if (!agents.has(id)) return;
		const existing = completions.get(id);
		completions.set(id, {
			...completion,
			...existing,
			// A later record fills fields the first one lacked, never overrides them.
			summary: existing?.summary ?? completion.summary,
			durationMs: existing?.durationMs ?? completion.durationMs,
		});
	};
	const recordTask = (toolCallId: string, details: Record<string, unknown> | undefined, timestamp: number) => {
		const rows = [
			...(Array.isArray(details?.progress) ? details.progress : []),
			...(Array.isArray(details?.results) ? details.results : []),
		];
		for (const value of rows) {
			const row = asRecord(value);
			if (!row || typeof row.id !== "string") continue;
			const previous = agents.get(row.id);
			agents.set(row.id, {
				id: row.id,
				index: typeof row.index === "number" ? row.index : (previous?.index ?? agents.size),
				agent: typeof row.agent === "string" ? row.agent : (previous?.agent ?? "task"),
				...(row.agentSource === "bundled" || row.agentSource === "user" || row.agentSource === "project"
					? { agentSource: row.agentSource }
					: {}),
				description: typeof row.description === "string" ? row.description : previous?.description,
				assignment: typeof row.assignment === "string" ? row.assignment : previous?.assignment,
				task: typeof row.task === "string" ? row.task : previous?.task,
				status: typeof row.status === "string" ? row.status : (previous?.status ?? "pending"),
				lastUpdate: timestamp,
				parentToolCallId: toolCallId,
				kind: "sub",
			});
		}
		for (const value of Array.isArray(details?.results) ? details.results : []) {
			const row = asRecord(value);
			if (row && typeof row.id === "string") settle(row.id, singleResultCompletion(row));
		}
	};
	const settleFrom = (details: Record<string, unknown> | undefined, text: string) => {
		if (agents.size === 0) return;
		if (text.includes("<task-result"))
			for (const { id, ...completion } of parseTaskResults(text)) settle(id, completion);
		// async-result: jobs[].agentId/jobId; wait: jobs[].id. Only task jobs settle agents.
		for (const value of Array.isArray(details?.jobs) ? details.jobs : []) {
			const job = asRecord(value);
			if (!job || (job.type !== undefined && job.type !== "task")) continue;
			const id = [job.agentId, job.id, job.jobId].find(
				(candidate): candidate is string => typeof candidate === "string" && agents.has(candidate),
			);
			if (id && completions.has(id) && typeof job.durationMs === "number")
				settle(id, { durationMs: job.durationMs });
		}
	};
	for (const call of taskCalls) {
		const details = resultDetails(call.result);
		recordTask(call.toolCallId, details, call.timestamp);
		settleFrom(details, resultText(call.result));
	}
	// Settlements follow the spawn; a transcript page without the spawning call still settles known agents.
	const spawn = messages.findIndex(
		message =>
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "toolCall" && block.name === "task" && ownsCall(block.id)),
	);
	for (let index = Math.max(0, spawn); index < messages.length; index++) {
		const message = messages[index];
		if (!message) continue;
		const details = asRecord(message.details);
		if (message.role === "toolResult" && message.toolName === "task" && message.toolCallId) {
			if (!ownsCall(message.toolCallId)) continue;
			recordTask(message.toolCallId, details, messageSourceTimestamp(message) ?? 0);
		}
		if (message.role === "toolResult" || (message.role === "custom" && message.customType === "async-result"))
			settleFrom(details, resultText(message.content));
	}
	return { agents: [...agents.values()], completions };
}

const TERMINAL: Record<string, true> = { completed: true, failed: true, aborted: true, cancelled: true };

/**
 * The run's lanes: stock registry rows (live status, progress) first, then the
 * agents only the transcript still remembers. A transcript agent that never
 * settled and is not live anymore was cut off with its run.
 */
export function mergeRunAgents(live: readonly SubagentNode[], transcript: RunTranscript): SubagentNode[] {
	const byId = new Map(live.map(node => [node.id, node]));
	for (const node of transcript.agents) {
		if (byId.has(node.id)) continue;
		const status = transcript.completions.get(node.id)?.status ?? (TERMINAL[node.status] ? node.status : "aborted");
		byId.set(node.id, { ...node, status });
	}
	return [...byId.values()].sort((a, b) => a.index - b.index);
}

/**
 * A settled lane's conclusion: stock's completion record, else the finished
 * progress snapshot (its yield, or its final text, whose newest lines come first).
 */
export function agentConclusion(node: SubagentNode, completion: AgentCompletion | undefined): string | undefined {
	if (completion?.summary) return completion.summary;
	const yielded = node.progress ? agentResultSummary({ extractedToolData: node.progress.extractedToolData }) : null;
	return completionHeadline(yielded ?? node.progress?.recentOutput?.at(-1));
}

/** A settled lane's duration from the same stock record live and after a reload. */
export function agentDurationMs(node: SubagentNode, completion: AgentCompletion | undefined): number {
	return completion?.durationMs ?? node.progress?.durationMs ?? 0;
}

/**
 * The run's clock from stock message timestamps: its first tool call's message
 * to its last tool result, the same clock the transcript replays after a reload.
 */
export function runSpan(
	messages: readonly AgentMessage[],
	ownsCall: (id: string) => boolean,
): { startedAt?: number; spanMs: number } {
	let start = Number.POSITIVE_INFINITY;
	let end = 0;
	for (const message of messages) {
		const timestamp = messageSourceTimestamp(message);
		if (timestamp === undefined) continue;
		if (
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some(block => block.type === "toolCall" && ownsCall(block.id))
		)
			start = Math.min(start, timestamp);
		else if (message.role === "toolResult" && message.toolCallId && ownsCall(message.toolCallId))
			end = Math.max(end, timestamp);
	}
	if (!Number.isFinite(start)) return { spanMs: 0 };
	return { startedAt: start, spanMs: end > start ? end - start : 0 };
}

/** The run's own todo state: its last todo call's result, as stock recorded it. */
export function transcriptTodoSnapshot(entries: readonly (readonly [string, ToolEntry])[]): TodoSnapshot | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const [id, entry] = entries[index] ?? [];
		if (!id || !entry || entry.status !== "done") continue;
		const phases = resultDetails(entry.result)?.phases;
		if (!Array.isArray(phases)) continue;
		const parsed = phases.flatMap(value => {
			const phase = asRecord(value);
			if (!phase || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return [];
			const tasks = phase.tasks.flatMap(item => {
				const task = asRecord(item);
				return task && typeof task.content === "string" && typeof task.status === "string"
					? [
							{
								content: task.content,
								status: task.status as TodoSnapshot["phases"][number]["tasks"][number]["status"],
							},
						]
					: [];
			});
			return [{ name: phase.name, tasks }];
		});
		if (parsed.some(phase => phase.tasks.length > 0))
			return { id: `todo-tool-${id}`, ts: entry.endTime ?? entry.startTime, phases: parsed };
	}
	return undefined;
}

/**
 * A finished card's head: what the run was for (its goal, its todo list's title,
 * or a lone agent's task description), never a copy of the reply below it.
 */
export function finishedHeadline({
	goal,
	todo,
	agents,
}: {
	goal?: string;
	todo?: TodoSnapshot;
	agents: readonly SubagentNode[];
}): string | undefined {
	const objective = goal?.trim();
	if (objective) return objective.split("\n")[0];
	const phase = todo?.phases.find(item => item.tasks.length > 0)?.name.trim();
	if (phase) return phase;
	if (agents.length === 1) return agents[0]?.description?.trim() || undefined;
	return undefined;
}

/** A path as the project sees it: relative inside the session's cwd, absolute elsewhere. */
export function projectPath(path: string, cwd: string): string {
	const key = workFilePathKey(path, cwd);
	if (!cwd) return key;
	// macOS reports temp dirs both with and without the /private firmlink.
	const strip = (value: string) => value.replace(/^\/private(?=\/(?:var|tmp|etc)\/)/, "");
	const base = strip(workFilePathKey(cwd));
	const target = strip(key);
	return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : key;
}
