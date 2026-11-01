import {
	RESTART_JOBS_MESSAGE,
	RESTART_SUBAGENTS_MESSAGE,
	RESTART_TURN_MESSAGE,
} from "../../../resources/gui-bridge/restart-core";
import type { AgentMessage } from "../../shared/rpc-types";
import { asyncJobResults, asyncResultJobs } from "../components/chat/completion-events";
import { resultText } from "./format";
import { asRecord } from "./wire-value";

/**
 * The one rule for a subagent a restart ended (2 Nov 2026, the 0.94.0 → 0.94.1 update restart: each revived
 * subagent ended at once and stock reported `failed` with its empty-message warning). It lives here, import-light,
 * because the transcript's cards, the work lanes and the per-tab subagents store (every other surface) all read it.
 */
export const RESTART_NOTES = new Set<unknown>([RESTART_JOBS_MESSAGE, RESTART_SUBAGENTS_MESSAGE, RESTART_TURN_MESSAGE]);

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

/** The committed and live messages' cuts: the joined list is built only when a live message can carry a delivery. */
export function restartCutsOf(committed: readonly AgentMessage[], live: readonly AgentMessage[]): RestartCuts {
	return restartCuts(live.some(message => message.role === "custom") ? transcriptOf(committed, live) : committed);
}

/** The status token of a subagent whose end a restart caused: not live, never counted as failed. */
export const RESTART_CUT_STATUS = "restart-cut";

/** What a node carries once `markCut` read it: stock's own status and the cut. */
export interface CutMark {
	stockStatus?: string;
	restartCut?: RestartCut;
}

/**
 * The node as every surface reads it: a `failed` agent the transcript says a restart ended takes the
 * `restart-cut` status (stock's own kept in `stockStatus`); any other status, an agent that runs again included,
 * is returned as it is. Idempotent.
 */
export function markCut<T extends { id: string; status: string }>(
	node: T & CutMark,
	cuts: ReadonlyMap<string, RestartCut>,
): T & CutMark {
	const cut = node.status === "failed" ? cuts.get(node.id) : undefined;
	return cut ? { ...node, status: RESTART_CUT_STATUS, stockStatus: "failed", restartCut: cut } : node;
}

/** `markCut` undone: the node with stock's own status back (when the cuts change, the node is marked again). */
export function unmarkCut<T extends { status: string }>(node: T & CutMark): T & CutMark {
	if (node.stockStatus === undefined) return node;
	const { stockStatus, restartCut: _cut, ...rest } = node;
	return { ...rest, status: stockStatus } as T & CutMark;
}

/** What a cut agent was doing when the restart stopped it (the bridge's `doing`, else its `intent`). */
export function restartCutNote(node: CutMark): string | undefined {
	return node.restartCut?.doing ?? node.restartCut?.intent;
}
