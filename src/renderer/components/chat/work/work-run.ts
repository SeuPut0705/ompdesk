import { assignmentTitle } from "../../../../../resources/gui-bridge/modes/subagent-title-contracts";
import {
	RESTART_JOBS_MESSAGE,
	RESTART_SUBAGENTS_MESSAGE,
	RESTART_TURN_MESSAGE,
} from "../../../../../resources/gui-bridge/restart-core";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { resultDetails, resultText } from "../../../lib/format";
import { asRecord } from "../../../lib/wire-value";
import type { SubagentNode } from "../../../stores/subagents";
import type { TodoSnapshot } from "../../../stores/todo";
import type { ToolEntry } from "../../../stores/tools";
import { workFilePathKey } from "../../tools/edit-args";
import { asyncJobResults, asyncResultJobs } from "../completion-events";
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

type TaskResult = { id: string } & AgentCompletion;
const NO_TASK_RESULTS: readonly TaskResult[] = [];
const recordedTaskResults = new WeakMap<object, readonly TaskResult[]>();

/**
 * The `<task-result>` envelopes in one stock record (a transcript message or a tool
 * result), parsed once. Every work card rescans the transcript after its spawn
 * whenever the transcript changes, and stock records are never edited in place.
 */
function recordTaskResults(record: unknown, content: unknown): readonly TaskResult[] {
	const cached = typeof record === "object" && record !== null ? recordedTaskResults.get(record) : undefined;
	if (cached) return cached;
	const text = resultText(content);
	const results = text.includes("<task-result") ? parseTaskResults(text) : NO_TASK_RESULTS;
	if (typeof record === "object" && record !== null) recordedTaskResults.set(record, results);
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

/**
 * A finished task call of this run as the tools store holds it (live or hydrated). A call
 * that ended without any stock result (its process was gone before it answered) has a null
 * `result` and keeps its arguments, the only record of the agents it started.
 */
export interface TaskCallResult {
	toolCallId: string;
	result: unknown;
	timestamp: number;
	args?: Record<string, unknown>;
}

/**
 * The agents an unanswered task call started, from its arguments alone: a batch's `tasks[]`
 * or the flat spec. Stock names each one by its spec name, else `#<position>` (task/index.ts
 * "Task #2: cancelled before start."; pi-tui task.ts renderTaskCallLines); the id it
 * allocated from that name was never recorded.
 */
function argumentAgents(args: Record<string, unknown>): Array<{ name: string; agent?: string; task?: string }> {
	const specs = Array.isArray(args.tasks) ? args.tasks.map(asRecord) : [args];
	return specs.map((spec, index) => {
		const name = typeof spec?.name === "string" ? spec.name.trim() : "";
		const agent = [spec?.agent, args.agent].find((value): value is string => typeof value === "string");
		return {
			name: name || `#${index + 1}`,
			...(agent ? { agent } : {}),
			...(typeof spec?.task === "string" ? { task: spec.task } : {}),
		};
	});
}

/** Where one message list spawned each task call, and which of its messages can settle an agent. */
interface TaskIndex {
	/** Stock task call id → the first assistant message calling it. */
	spawns: ReadonlyMap<string, number>;
	/** Task results and records carrying `<task-result>` envelopes or jobs, in order. */
	records: readonly number[];
}

const taskIndexes = new WeakMap<readonly AgentMessage[], TaskIndex>();

/**
 * Each message list's task calls and settlement records, indexed once per list:
 * every work card that spawned agents scans from its spawn to the end of the
 * transcript, and for the cards at the top of a long session that was the whole
 * transcript, once per card on every history page. Messages that carry nothing an
 * agent settles on are skipped here rather than in every scan.
 */
function taskIndex(messages: readonly AgentMessage[]): TaskIndex {
	const cached = taskIndexes.get(messages);
	if (cached) return cached;
	const spawns = new Map<string, number>();
	const records: number[] = [];
	messages.forEach((message, index) => {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content)
				if (block.type === "toolCall" && block.name === "task" && !spawns.has(block.id))
					spawns.set(block.id, index);
			return;
		}
		const settles =
			message.role === "toolResult" || (message.role === "custom" && message.customType === "async-result");
		if (!settles) return;
		const jobs = asRecord(message.details)?.jobs;
		if (
			(message.role === "toolResult" && message.toolName === "task" && message.toolCallId) ||
			(Array.isArray(jobs) && jobs.length > 0) ||
			recordTaskResults(message, message.content).length > 0
		)
			records.push(index);
	});
	const index = { spawns, records };
	taskIndexes.set(messages, index);
	return index;
}

/**
 * Agents and their completions for the task calls this run owns. Completions
 * may land after the run's reply (a detached agent finishing in a follow-up
 * turn), so the scan runs to the end of the transcript; the first settlement
 * of an agent id after its spawn wins. `messages` is indexed once per list (see
 * taskIndex), so it must not be edited in place.
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
				description:
					assignmentTitle(typeof row.assignment === "string" ? row.assignment : previous?.assignment) ??
					(typeof row.description === "string" ? row.description : previous?.description),
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
	const settleFrom = (details: Record<string, unknown> | undefined, record: unknown, content: unknown) => {
		if (agents.size === 0) return;
		for (const { id, ...completion } of recordTaskResults(record, content)) settle(id, completion);
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
		settleFrom(details, call.result, call.result);
	}
	// Before the transcript scan, so a later stock record (a restored agent's delivery) still settles them.
	for (const call of taskCalls) {
		if (call.result != null || !call.args) continue;
		if ([...agents.values()].some(node => node.parentToolCallId === call.toolCallId)) continue;
		for (const spec of argumentAgents(call.args)) {
			if (agents.has(spec.name)) continue;
			agents.set(spec.name, {
				id: spec.name,
				index: agents.size,
				agent: spec.agent ?? "task",
				...(spec.task ? { assignment: spec.task, task: spec.task } : {}),
				status: "aborted",
				lastUpdate: call.timestamp,
				parentToolCallId: call.toolCallId,
				kind: "sub",
			});
		}
	}
	// Settlements follow the spawn; a transcript page without the spawning call still settles known agents.
	const { spawns, records } = taskIndex(messages);
	let spawn = Number.POSITIVE_INFINITY;
	for (const [id, index] of spawns) if (index < spawn && ownsCall(id)) spawn = index;
	const from = Number.isFinite(spawn) ? spawn : 0;
	for (const index of records) {
		const message = messages[index];
		if (index < from || !message) continue;
		const details = asRecord(message.details);
		if (message.role === "toolResult" && message.toolName === "task" && message.toolCallId) {
			if (!ownsCall(message.toolCallId)) continue;
			recordTask(message.toolCallId, details, messageSourceTimestamp(message) ?? 0);
		}
		settleFrom(details, message, message.content);
	}
	return { agents: [...agents.values()], completions };
}

const TERMINAL: Record<string, true> = { completed: true, failed: true, aborted: true, cancelled: true };

/**
 * The run's lanes: stock registry rows (live status, progress) first, then the
 * agents only the transcript still remembers. A transcript agent that never
 * settled and is not live anymore was cut off with its run. A registry row with
 * no spawning call is an agent a restart's restore revived (the omp that spawned
 * it is gone): while it works it takes the lane its spawn named, keeping that
 * lane's place and title; any other row without a call belongs to no lane.
 */
export function mergeRunAgents(live: readonly SubagentNode[], transcript: RunTranscript): SubagentNode[] {
	const spawned = new Map(transcript.agents.map(node => [node.id, node]));
	const byId = new Map<string, SubagentNode>();
	for (const node of live) {
		if (node.parentToolCallId) {
			byId.set(node.id, node);
			continue;
		}
		const lane = spawned.get(node.id);
		if (!lane || node.status !== "running") continue;
		byId.set(node.id, {
			...node,
			index: lane.index,
			parentToolCallId: lane.parentToolCallId,
			description: node.description ?? lane.description,
			assignment: node.assignment ?? lane.assignment,
		});
	}
	for (const node of transcript.agents) {
		if (byId.has(node.id)) continue;
		const status = transcript.completions.get(node.id)?.status ?? (TERMINAL[node.status] ? node.status : "aborted");
		byId.set(node.id, { ...node, status });
	}
	return [...byId.values()].sort((a, b) => a.index - b.index);
}

const RESTART_NOTES = new Set<unknown>([RESTART_JOBS_MESSAGE, RESTART_SUBAGENTS_MESSAGE, RESTART_TURN_MESSAGE]);
const NONE: ReadonlySet<string> = new Set();

/**
 * The subagents the newest restart note names as working again (the bridge's follow-up, `details.subagents`) that
 * have not reported back since (a later `async-result` naming the job). A revived agent's first request can take
 * minutes; until it reports, its lane and board row say it resumes after the restart.
 */
export function resumedAgents(messages: readonly AgentMessage[]): ReadonlySet<string> {
	const settled = new Set<string>();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "custom") continue;
		const details = asRecord(message.details);
		if (RESTART_NOTES.has(message.customType)) {
			const named = Array.isArray(details?.subagents) ? details.subagents : [];
			const ids = named.flatMap(item => {
				const id = asRecord(item)?.id;
				return typeof id === "string" && !settled.has(id) ? [id] : [];
			});
			return ids.length > 0 ? new Set(ids) : NONE;
		}
		if (message.customType !== "async-result") continue;
		for (const value of Array.isArray(details?.jobs) ? details.jobs : []) {
			const job = asRecord(value);
			for (const id of [job?.agentId, job?.jobId, job?.id]) if (typeof id === "string") settled.add(id);
		}
	}
	return NONE;
}

/** What a restart cut a subagent in, from the note that named it (`details.subagents[]`). */
export interface RestartCut {
	/** The assignment's title line. */
	intent?: string;
	/** The calls the stop cut, in the bridge's words (`bash: probing the stream`). */
	doing?: string;
}

/** Stock's `SUBAGENT_WARNING_EMPTY_MESSAGE` (task/executor.ts): what a subagent that ended with no message delivers. */
const EMPTY_MESSAGE_WARNING = "SYSTEM WARNING: Subagent ended without a final message.";
const RESULT_BLOCK = /<(error|output)>([\s\S]*?)<\/\1>/g;
const NO_OUTPUT = /^\(no output\)(?: after \d+ req)?$/;

/**
 * Whether a failed task job's delivered text says nothing but that the agent ended with no message: stock's
 * warning, its "(no output)" placeholder or no text at all, in the `<error>` and `<output>` of its
 * `<task-result>`. Any real error text, or any other part of the envelope (an abort reason, a preview), is a failure.
 */
export function endedWithoutMessage(text: string | undefined): boolean {
	const body = (text ?? "").replace(/<\/?task-result\b[^>]*>/g, "");
	const blocks = [...body.matchAll(RESULT_BLOCK)].map(match => match[2]?.trim() ?? "");
	const rest = body.replace(RESULT_BLOCK, "").trim();
	if (blocks.length > 0 && rest) return false;
	return (blocks.length > 0 ? blocks : [rest]).every(
		said => said === "" || said === EMPTY_MESSAGE_WARNING || NO_OUTPUT.test(said),
	);
}

export interface RestartCuts {
	/** Per `async-result` message: each task job a restart cut, by job id. */
	deliveries: ReadonlyMap<AgentMessage, ReadonlyMap<string, RestartCut>>;
	/** Every subagent whose delivered end was a restart's, by agent id. */
	agents: ReadonlyMap<string, RestartCut>;
}

const restartCutIndexes = new WeakMap<readonly AgentMessage[], RestartCuts>();

/**
 * The one rule for a subagent the restart ended: a delivered `task` job that failed with stock's empty-message
 * warning (or no output) and whose agent id the newest restart note before the delivery names
 * (`details.subagents[].id`: the revive ended it at once). Any other failure stays a failure. Indexed once per list
 * (every async-result card and lane of a transcript reads one pass), so a list must not be edited in place.
 */
export function restartCuts(messages: readonly AgentMessage[]): RestartCuts {
	const cached = restartCutIndexes.get(messages);
	if (cached) return cached;
	const named = new Map<string, RestartCut>();
	const deliveries = new Map<AgentMessage, ReadonlyMap<string, RestartCut>>();
	const agents = new Map<string, RestartCut>();
	for (const message of messages) {
		if (message.role !== "custom") continue;
		if (RESTART_NOTES.has(message.customType)) {
			const subagents = asRecord(message.details)?.subagents;
			for (const item of Array.isArray(subagents) ? subagents : []) {
				const row = asRecord(item);
				if (typeof row?.id !== "string") continue;
				const intent = typeof row.intent === "string" && row.intent.trim() ? row.intent.trim() : undefined;
				const doing = typeof row.doing === "string" && row.doing.trim() ? row.doing.trim() : undefined;
				named.set(row.id, { ...(intent ? { intent } : {}), ...(doing ? { doing } : {}) });
			}
			continue;
		}
		if (message.customType !== "async-result") continue;
		const jobs = asyncResultJobs(message);
		const texts = asyncJobResults(resultText(message.content), jobs);
		const cut = new Map<string, RestartCut>();
		for (const job of jobs) {
			const id = [job.agentId, job.jobId].find(candidate => candidate !== undefined && named.has(candidate));
			const was = id === undefined ? undefined : named.get(id);
			if (id === undefined || !was) continue;
			// A delivery settles the name: a later one for the same id needs a later note.
			named.delete(id);
			if (job.type !== "task" || job.status !== "failed") continue;
			if (!endedWithoutMessage(job.jobId ? texts.get(job.jobId) : undefined)) continue;
			cut.set(job.jobId ?? id, was);
			agents.set(id, was);
		}
		if (cut.size > 0) deliveries.set(message, cut);
	}
	const index = { deliveries, agents };
	restartCutIndexes.set(messages, index);
	return index;
}

const joinedTranscripts = new WeakMap<
	readonly AgentMessage[],
	{ committed: readonly AgentMessage[]; joined: readonly AgentMessage[] }
>();

/** The committed messages with the live ones behind them, one array per pair so `restartCuts` indexes it once. */
export function transcriptOf(
	committed: readonly AgentMessage[],
	live: readonly AgentMessage[],
): readonly AgentMessage[] {
	if (live.length === 0) return committed;
	const hit = joinedTranscripts.get(live);
	if (hit?.committed === committed) return hit.joined;
	const joined = [...committed, ...live];
	joinedTranscripts.set(live, { committed, joined });
	return joined;
}

/**
 * The lanes with the agents a restart ended read as interrupted, not failed: their status and settled record say
 * so, and carry neither stock's warning nor its sub-second duration. An agent that runs again keeps running.
 */
export function cutRunAgents(
	agents: SubagentNode[],
	completions: ReadonlyMap<string, AgentCompletion>,
	cuts: ReadonlyMap<string, RestartCut>,
): { agents: SubagentNode[]; completions: ReadonlyMap<string, AgentCompletion> } {
	const ended = agents.filter(agent => agent.status === "failed" && cuts.has(agent.id));
	if (ended.length === 0) return { agents, completions };
	const settled = new Map(completions);
	for (const agent of ended) settled.set(agent.id, { status: "aborted" });
	return {
		agents: agents.map(agent => (ended.includes(agent) ? { ...agent, status: "aborted" } : agent)),
		completions: settled,
	};
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

/** When one stock tool call was made (its earliest call message) and last answered. */
interface CallTimes {
	calledAt: number;
	answeredAt: number;
}

const transcriptCallTimes = new WeakMap<readonly AgentMessage[], ReadonlyMap<string, CallTimes>>();

/**
 * Every tool call's times in one message list, indexed once per list: each work
 * card on screen reads its run's clock from it, and a history page prepend made
 * every one of them rescan the whole transcript.
 */
function callTimes(messages: readonly AgentMessage[]): ReadonlyMap<string, CallTimes> {
	const cached = transcriptCallTimes.get(messages);
	if (cached) return cached;
	const times = new Map<string, CallTimes>();
	const timesOf = (id: string) => {
		let entry = times.get(id);
		if (!entry) {
			entry = { calledAt: Number.POSITIVE_INFINITY, answeredAt: 0 };
			times.set(id, entry);
		}
		return entry;
	};
	for (const message of messages) {
		const timestamp = messageSourceTimestamp(message);
		if (timestamp === undefined) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const entry = timesOf(block.id);
				entry.calledAt = Math.min(entry.calledAt, timestamp);
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			const entry = timesOf(message.toolCallId);
			entry.answeredAt = Math.max(entry.answeredAt, timestamp);
		}
	}
	transcriptCallTimes.set(messages, times);
	return times;
}

/**
 * The run's clock from stock message timestamps: its first tool call's message
 * to its last tool result, the same clock the transcript replays after a reload.
 * A call stock never answered (a run cut off by a quit) still ran from its call.
 * `callIds` are the stock call ids the run owns; `lists` the committed and live
 * messages (each list is indexed once, so lists must not be edited in place).
 */
export function runSpan(
	lists: readonly (readonly AgentMessage[])[],
	callIds: readonly string[],
): { startedAt?: number; spanMs: number } {
	let start = Number.POSITIVE_INFINITY;
	let end = 0;
	for (const messages of lists) {
		const times = callTimes(messages);
		for (const id of callIds) {
			const entry = times.get(id);
			if (!entry) continue;
			start = Math.min(start, entry.calledAt);
			end = Math.max(end, entry.answeredAt, Number.isFinite(entry.calledAt) ? entry.calledAt : 0);
		}
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
 * A finished card's head: what the whole run was for (its goal, its todo list's title),
 * never a copy of the reply below it. A lone agent's task is not the run's: its lane
 * right below names it, and the run may have done more around it, so the head then
 * states how the run ended.
 */
export function finishedHeadline({ goal, todo }: { goal?: string; todo?: TodoSnapshot }): string | undefined {
	const objective = goal?.trim();
	if (objective) return objective.split("\n")[0];
	return todo?.phases.find(item => item.tasks.length > 0)?.name.trim() || undefined;
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
