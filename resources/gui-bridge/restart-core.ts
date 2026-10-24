/**
 * What a relaunch's restore (`composer.restore_interrupted`) reads from the session journal
 * beyond stock `restoreSession`: the background bash jobs the last process started and never
 * finished, the subagents the restore revived while the session's own turn stays idle, and
 * whether a goal was still active when it ended. Pure over journal entries, so the rules are
 * unit-tested without a session (src/main/bridge-restart.test.ts).
 */
import { assignmentHeadline } from "./modes/subagent-title-contracts";

/** The slice of a stock session entry read here. */
export interface JournalEntry {
	type: string;
	customType?: string;
	mode?: string;
	details?: unknown;
	/** A `custom_message` entry's content. */
	content?: unknown;
	/** A `custom` entry's data (a `session_exit`'s `{kind, pendingToolCalls}`). */
	data?: unknown;
	/** ISO time the entry was journaled (stock `SessionEntry.timestamp`). */
	timestamp?: string;
	message?: { role?: string; content?: unknown; toolCallId?: string; details?: unknown; stopReason?: string };
}

/** Stock's journal record of a process ending (exit-diagnostics.ts `SESSION_EXIT_CUSTOM_TYPE`). */
const SESSION_EXIT = "session_exit";
/** Stock's follow-up carrying finished background jobs (async-job-delivery.ts `ASYNC_RESULT_MESSAGE_TYPE`). */
const ASYNC_RESULT = "async-result";
/** The follow-up naming cut-off jobs (and any revived subagents with them). */
export const RESTART_JOBS_MESSAGE = "ompdesk-restart-jobs";
/** The follow-up naming only revived subagents, for a session whose own turn the restore did not continue. */
export const RESTART_SUBAGENTS_MESSAGE = "ompdesk-restart-subagents";
/** The follow-up that continues a turn the restart cut off when stock's own retry cannot see it (`turnCutBehindNotes`). */
export const RESTART_TURN_MESSAGE = "ompdesk-restart-turn";
/** Stock's eval runtime snapshot (eval/state.ts `EVAL_STATE_CONTEXT_TYPE`), journaled at every session start. */
const EVAL_STATE_CONTEXT = "eval-state-context";

export interface InterruptedJob {
	id: string;
	command: string;
	/** What the agent said the call was for (the `i` argument every stock tool call carries). */
	intent?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isExit(entry: JournalEntry): boolean {
	return entry.type === "custom" && entry.customType === SESSION_EXIT;
}

/** `details.async` of a stock bash result: `{state, jobId, type}`. */
function asyncState(details: unknown): { state: string; jobId: string; type: string } | undefined {
	if (!isObject(details) || !isObject(details.async)) return undefined;
	const { state, jobId, type } = details.async;
	return typeof state === "string" && typeof jobId === "string" && typeof type === "string"
		? { state, jobId, type }
		: undefined;
}

/** The `command` and `i` (intent) arguments of tool call `toolCallId` in an assistant entry. */
function toolCallArguments(entry: JournalEntry, toolCallId: string): { command: string; intent?: string } | undefined {
	const content = entry.message?.role === "assistant" ? entry.message.content : undefined;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (!isObject(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		const args = block.arguments;
		if (!isObject(args) || typeof args.command !== "string") return undefined;
		const intent = typeof args.i === "string" ? args.i.trim() : "";
		return intent ? { command: args.command, intent } : { command: args.command };
	}
	return undefined;
}

/**
 * A later entry that settles job `id`: its async-result delivery, a settled job frame, a wait/jobs report naming it,
 * or an earlier relaunch's notice that already named it to the agent.
 */
function settles(entry: JournalEntry, id: string): boolean {
	if (entry.type === "custom_message" && entry.customType === ASYNC_RESULT) {
		const jobs = isObject(entry.details) ? entry.details.jobs : undefined;
		return Array.isArray(jobs) && jobs.some(job => isObject(job) && job.jobId === id);
	}
	if (entry.type === "custom_message" && entry.customType === RESTART_JOBS_MESSAGE) {
		return JSON.stringify(entry.content ?? "").includes(`- ${id}:`);
	}
	if (entry.type !== "message" || entry.message?.role !== "toolResult") return false;
	const state = asyncState(entry.message.details);
	if (state?.jobId === id) return state.state !== "running";
	// Stock's `wait`/`jobs` report: "### <id> [bash] — completed".
	return JSON.stringify(entry.message.content ?? "").includes(`### ${id} [`);
}

/**
 * Background bash jobs the processes this one replaced started and never settled: they took them down. Their entries
 * are the ones journaled before `startedAt`, this process's start (epoch ms), never cut at a `session_exit` alone,
 * which stock does not journal for a SIGKILL or a crash and not always when its stdin closes. The life looked at
 * starts after the second-to-last `session_exit` among them: the last one may be the dying process's own (stock
 * journals it before the turn's abort) or the one before it, which then had its own relaunch; a job an earlier
 * relaunch already named (`RESTART_JOBS_MESSAGE`) counts as settled.
 */
export function interruptedJobs(branch: readonly JournalEntry[], startedAt: number): InterruptedJob[] {
	const earlier = branch.filter(entry => journaledBefore(entry, startedAt));
	const exits = earlier.flatMap((entry, index) => (isExit(entry) ? [index] : []));
	const life = earlier.slice((exits.at(-2) ?? -1) + 1);
	const jobs: InterruptedJob[] = [];
	life.forEach((entry, index) => {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "toolResult" || !message.toolCallId) return;
		const state = asyncState(message.details);
		if (state?.state !== "running" || state.type !== "bash") return;
		if (branch.slice(branch.indexOf(entry) + 1).some(later => settles(later, state.jobId))) return;
		let call: { command: string; intent?: string } | undefined;
		for (let back = index - 1; back >= 0 && call === undefined; back--) {
			const candidate = life[back];
			if (candidate) call = toolCallArguments(candidate, message.toolCallId);
		}
		if (call !== undefined && !jobs.some(job => job.id === state.jobId)) jobs.push({ id: state.jobId, ...call });
	});
	return jobs;
}

/**
 * The goal mode the earlier processes journaled last was an active goal (`goal`, not `goal_paused`). Their entries are
 * the ones journaled before `startedAt`, this process's start (epoch ms): stock pauses an active goal when the session
 * loads, so this process's own `goal_paused` comes after. No `session_exit` is needed: stock journals none for a
 * SIGKILL or a crash, and not always when its RPC client closes stdin mid-turn, which is what a killed or quitting
 * OMPdesk does (omp 18.11 journaled only the aborted turn: src/main/bridge-autopilot-stock.test.ts).
 */
export function goalActiveAtExit(branch: readonly JournalEntry[], startedAt: number): boolean {
	const mode = branch.findLast(entry => entry.type === "mode_change" && journaledBefore(entry, startedAt));
	return mode?.mode === "goal";
}

function journaledBefore(entry: JournalEntry, at: number): boolean {
	const time = entry.timestamp === undefined ? Number.NaN : Date.parse(entry.timestamp);
	return Number.isFinite(time) && time < at;
}

/**
 * The exit record of a turn its last process ended between a message and the model's answer to it, which stock's own
 * restore reads as finished; undefined for anything else.
 *
 * Stock records `session_exit` as `normal` when it disposes the session on stdin EOF (how OMPdesk stops an omp at a
 * quit), with `pendingToolCalls` only while a tool runs. Its `findUnfinishedTurn` (session/exit-diagnostics.ts) reads
 * a normal exit with nothing pending as a turn that ended, trusting the abort record the dying turn writes after the
 * exit, which `/retry` then replays. That record never reaches the journal when the turn is cut before its model call
 * (the agent loop stops there without a message) or the process ends first (stdout EPIPE as the app goes: stock's
 * graceful quit). v0.41.0's update restart left exactly that: a bash result, then the exit record, nothing after.
 *
 * The caller (a relaunch the host makes for a turn it saw running) closes the turn with stock's own interrupted-turn
 * record, as stock does for an exit it knows was abnormal, so stock's restore continues it. The tail is a prompt or a
 * tool result nothing answered; a tool result that closes a failed or aborted reply ended its turn (stock's rule).
 * Only an exit of the processes this one replaced (journaled before `startedAt`) with no message after it counts.
 */
export function requestCutAtExit(branch: readonly JournalEntry[], startedAt: number): JournalEntry | undefined {
	const exitAt = branch.findLastIndex(isExit);
	const exit = branch[exitAt];
	if (!exit || !journaledBefore(exit, startedAt) || !isObject(exit.data)) return undefined;
	const { kind, pendingToolCalls } = exit.data;
	if (kind !== "normal" || (Array.isArray(pendingToolCalls) && pendingToolCalls.length > 0)) return undefined;
	if (branch.slice(exitAt + 1).some(entry => entry.type === "message")) return undefined;
	const messages = branch.slice(0, exitAt).filter(entry => entry.type === "message");
	const tail = messages.at(-1)?.message?.role;
	if (tail === "user") return exit;
	if (tail !== "toolResult") return undefined;
	const reply = messages.findLast(entry => entry.message?.role === "assistant")?.message?.stopReason;
	return reply === "error" || reply === "aborted" ? undefined : exit;
}

/**
 * The journal's end a restore judged, for the host's log (`restored: nothing` says why): the last message's role and
 * stop reason, and the last process exit after it (`exit normal`, `+pending` with tool calls in flight) or `no exit`.
 */
export function journalEnd(branch: readonly JournalEntry[]): string {
	const tailAt = branch.findLastIndex(entry => entry.type === "message");
	const tail = branch[tailAt]?.message;
	const exit = branch.slice(tailAt + 1).findLast(isExit)?.data;
	const kind = isObject(exit) && typeof exit.kind === "string" ? exit.kind : undefined;
	const pending = isObject(exit) && Array.isArray(exit.pendingToolCalls) && exit.pendingToolCalls.length > 0;
	const message = tail ? [tail.role, tail.stopReason].filter(Boolean).join("/") : "no message";
	return `${message}, ${kind ? `exit ${kind}${pending ? "+pending" : ""}` : "no exit"}`;
}

/**
 * A turn the processes this one replaced ended aborted or failed (the quit cut it mid-tool, and stock journaled the
 * aborted result and reply), with a custom message journaled after that reply and nothing anyone typed since.
 *
 * Stock's `retry` (session/turn-recovery.ts `retryableAssistantTurnEnd`) reads the conversation's end past its eval
 * snapshots only, so any other custom message after the aborted reply hides it and `/retry` answers "Nothing to retry".
 * The v0.48.0 → v0.49.0 update restart left exactly that in two sessions: a report the bridge handed the session once
 * the abort left it idle (`ompdesk.mail`), and a follow-up stock had queued since an earlier relaunch, journaled at the
 * abort with its old timestamp. With only eval snapshots after the reply stock's retry continues it, so this is false.
 * The caller (a relaunch the host makes for a turn it saw running) continues it with one follow-up instead.
 */
export function turnCutBehindNotes(branch: readonly JournalEntry[], startedAt: number): boolean {
	const tailAt = branch.findLastIndex(entry => entry.type === "message");
	const tail = branch[tailAt];
	const message = tail?.message;
	if (!tail || message?.role !== "assistant" || !journaledBefore(tail, startedAt)) return false;
	if (message.stopReason !== "aborted" && message.stopReason !== "error") return false;
	return branch
		.slice(tailAt + 1)
		.some(entry => entry.type === "custom_message" && entry.customType !== EVAL_STATE_CONTEXT);
}

/**
 * A background subagent the processes this one replaced took down when they shut down, which stock's restore cannot
 * see: `entries` are its transcript, `parent` the session's journal.
 *
 * A graceful stop (stdin closed: OMPdesk's app quit and update restart) disposes the session; the task executor parks
 * its subagents without a tombstone (abort kind `shutdown`) and their transcripts end on an aborted assistant reply
 * ("Request was aborted"). Stock's `hasRestorableTurn` reads that as a finished turn, so the relaunch revives nothing:
 * the parent's `wait` finds nothing to wait for and the work is lost (24 Oct 2026, two subagents, ~40 min redone). Only
 * a SIGKILL or a crash leaves the unanswered tool call stock does revive.
 *
 * The reply is the shutdown's when the parent's last `session_exit` before `startedAt` (this process's start, epoch ms)
 * came first (stock journals it as the dispose starts, the subagent's abort follows within moments) and the reply is
 * journaled before `startedAt`. An abort from before that exit (the parent cancelled the job, a runtime limit) or a
 * parent that journaled no exit proves nothing, so the subagent stays as it is; one the user stopped has a tombstone,
 * which the caller checks. The caller also leaves to stock a transcript it already revives (`hasRestorableTurn`).
 */
export function subagentCutByShutdown(
	entries: readonly JournalEntry[],
	parent: readonly JournalEntry[],
	startedAt: number,
): boolean {
	const exit = parent.findLast(entry => isExit(entry) && journaledBefore(entry, startedAt));
	const exitAt = exit?.timestamp === undefined ? Number.NaN : Date.parse(exit.timestamp);
	const tail = entries.findLast(entry => entry.type === "message");
	if (!Number.isFinite(exitAt) || tail?.message?.role !== "assistant" || tail.message.stopReason !== "aborted") {
		return false;
	}
	const abortedAt = tail.timestamp === undefined ? Number.NaN : Date.parse(tail.timestamp);
	return abortedAt >= exitAt && abortedAt < startedAt;
}

/** A subagent stock `restoreSession` revived: its id and what it was asked to do. */
export interface RevivedSubagent {
	id: string;
	/** The assignment's `Title:` line, else its first line (assignmentHeadline). */
	intent?: string;
}

/** Longest intent a list line carries. */
const INTENT_MAX_CHARS = 120;

/** The assignment of the latest `task` call that spawned `id` (stock names a spawned agent after its `name`). */
function assignmentOf(branch: readonly JournalEntry[], id: string): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const content = branch[index]?.message?.role === "assistant" ? branch[index]?.message?.content : undefined;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isObject(block) || block.type !== "toolCall" || block.name !== "task" || !isObject(block.arguments))
				continue;
			const tasks = block.arguments.tasks;
			const item = Array.isArray(tasks) ? tasks.find(task => isObject(task) && task.name === id) : undefined;
			if (isObject(item) && typeof item.task === "string") return item.task;
		}
	}
	return undefined;
}

/** The revived subagents `ids` with the intent the session's journal gave each (none for one it did not spawn). */
export function revivedSubagents(branch: readonly JournalEntry[], ids: readonly string[]): RevivedSubagent[] {
	return ids.map(id => {
		const headline = assignmentHeadline(assignmentOf(branch, id));
		if (!headline) return { id };
		return {
			id,
			intent: headline.length > INTENT_MAX_CHARS ? `${headline.slice(0, INTENT_MAX_CHARS - 1)}…` : headline,
		};
	});
}

/**
 * The agent's text. Model-facing only: the transcript shows one muted line per kind from the details (the
 * renderer's RestartNote), never this text. `- <id>` starts each list line (`settles` reads a job's `- <id>:`); the
 * intent follows so the agent can judge whether a job's result is still needed, or what a subagent is doing.
 */
function restartNotice(jobs: readonly InterruptedJob[], subagents: readonly RevivedSubagent[], turn: boolean): string {
	const lines: string[] = [];
	if (turn) {
		lines.push(
			"OMPdesk restarted while you were working and cut your turn off before it finished; the call it stopped shows as aborted above.",
			"Carry on with the task: run that call again if its result is still needed.",
		);
	}
	if (jobs.length > 0) {
		lines.push(
			"OMPdesk restarted and stopped these background jobs before they finished; their results will not arrive:",
			...jobs.map(job => `- ${job.id}: ${job.intent ? `${job.intent} — ` : ""}\`${job.command}\``),
			"Start again, in the background, only the jobs the work still needs; skip any whose result no longer matters.",
		);
	}
	if (subagents.length > 0) {
		lines.push(
			"These background agents you started are working again; their results reach you as usual:",
			...subagents.map(agent => `- ${agent.id}${agent.intent ? `: ${agent.intent}` : ""}`),
			"Check on them, tell the user in a sentence or two what is still in progress, and keep supervising them as before.",
		);
	}
	lines.push(
		subagents.length > 0
			? "Say nothing about the restart, this notice or how the work came back: no recap of it, no apology, no question."
			: "Say nothing about the restart or this notice: no recap, no apology, no question. Carry on with the task as if nothing happened.",
	);
	return lines.join("\n");
}

/** What the transcript's muted lines read from the message: ids and intents, never a job's command. */
export interface RestartDetails {
	jobs: Array<{ id: string; intent?: string }>;
	subagents?: Array<{ id: string; intent?: string }>;
	/** The follow-up also continues a turn the restart cut off. */
	turn?: true;
}

/** The one follow-up a relaunch's restore sends the agent: a displayed custom message, shown as muted lines. */
export interface RestartFollowUp {
	customType: typeof RESTART_JOBS_MESSAGE | typeof RESTART_SUBAGENTS_MESSAGE | typeof RESTART_TURN_MESSAGE;
	content: string;
	details: RestartDetails;
}

const listed = (items: readonly { id: string; intent?: string }[]) =>
	items.map(item => (item.intent ? { id: item.id, intent: item.intent } : { id: item.id }));

/**
 * The relaunch's one follow-up, or undefined when it has nothing to say: the cut-off jobs, the revived subagents
 * of a session whose own turn did not go on (the caller passes none when it did), and `turn`, a cut-off turn stock's
 * retry cannot see (`turnCutBehindNotes`). One message, so one turn.
 */
export function restartFollowUp(
	jobs: readonly InterruptedJob[],
	subagents: readonly RevivedSubagent[],
	turn = false,
): RestartFollowUp | undefined {
	if (jobs.length === 0 && subagents.length === 0 && !turn) return undefined;
	return {
		customType:
			jobs.length > 0
				? RESTART_JOBS_MESSAGE
				: subagents.length > 0
					? RESTART_SUBAGENTS_MESSAGE
					: RESTART_TURN_MESSAGE,
		content: restartNotice(jobs, subagents, turn),
		details: {
			jobs: listed(jobs),
			...(subagents.length > 0 ? { subagents: listed(subagents) } : {}),
			...(turn ? { turn: true as const } : {}),
		},
	};
}
