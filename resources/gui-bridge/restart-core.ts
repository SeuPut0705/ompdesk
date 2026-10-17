/**
 * What a relaunch's restore (`composer.restore_interrupted`) reads from the session journal
 * beyond stock `restoreSession`: the background bash jobs the last process started and never
 * finished, and whether a goal was still active when it ended. Pure over journal entries, so
 * the rules are unit-tested without a session (src/main/bridge-restart.test.ts).
 */

/** The slice of a stock session entry read here. */
export interface JournalEntry {
	type: string;
	customType?: string;
	mode?: string;
	details?: unknown;
	/** A `custom_message` entry's content. */
	content?: unknown;
	/** ISO time the entry was journaled (stock `SessionEntry.timestamp`). */
	timestamp?: string;
	message?: { role?: string; content?: unknown; toolCallId?: string; details?: unknown };
}

/** Stock's journal record of a process ending (exit-diagnostics.ts `SESSION_EXIT_CUSTOM_TYPE`). */
const SESSION_EXIT = "session_exit";
/** Stock's follow-up carrying finished background jobs (async-job-delivery.ts `ASYNC_RESULT_MESSAGE_TYPE`). */
const ASYNC_RESULT = "async-result";
/** The hidden follow-up naming cut-off jobs. */
export const RESTART_JOBS_MESSAGE = "ompdesk-restart-jobs";

export interface InterruptedJob {
	id: string;
	command: string;
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

function toolCallCommand(entry: JournalEntry, toolCallId: string): string | undefined {
	const content = entry.message?.role === "assistant" ? entry.message.content : undefined;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (!isObject(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isObject(block.arguments) && typeof block.arguments.command === "string"
			? block.arguments.command
			: undefined;
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
		let command: string | undefined;
		for (let back = index - 1; back >= 0 && command === undefined; back--) {
			const candidate = life[back];
			if (candidate) command = toolCallCommand(candidate, message.toolCallId);
		}
		if (command !== undefined && !jobs.some(job => job.id === state.jobId)) jobs.push({ id: state.jobId, command });
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

/** The agent's hidden follow-up: which jobs the restart stopped, and to go on. */
export function restartJobsNotice(jobs: readonly InterruptedJob[]): string {
	return [
		"OMPdesk restarted while background jobs of this session were still running. They stopped before finishing, and their results will not arrive:",
		...jobs.map(job => `- ${job.id}: \`${job.command}\``),
		"Run again whatever is still needed, then go on with the work.",
	].join("\n");
}
