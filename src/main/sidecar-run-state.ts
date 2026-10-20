/**
 * A tab's turn state, read from its sidecar's events. The local pool and the
 * tabs this machine hosts for paired devices share it, so "running" means the
 * same thing on every machine, and both report the same facts to their
 * computer's resume coordinator (turn-resume.ts).
 */
import type { IpcTabRunOutcome } from "../shared/ipc-types";
import type { AgentMessage, AgentSessionEvent } from "../shared/rpc-types";

export interface RunState {
	/** agent_start seen, its run not yet over. */
	running: boolean;
	/** The prompt yielded while background work can still wake the session. */
	awaitingSettled: boolean;
	/** A turn runs in front: agent_start seen, its last attempt not yet ended (`running` also covers settling). */
	turn: boolean;
	/** Inside an auto-retry saga: its coalesced agent_end is not the end of the run. */
	retrying: boolean;
	/** The saga's coalesced agent_end arrived while the retry was still outstanding. */
	endedWhileRetrying: boolean;
	/** Automatic compaction state once observed since the spawn; true blocks session mutation. */
	compacting?: boolean;
	/**
	 * When the current turn started (its agent_start, this process's clock), kept while background work follows it;
	 * absent while no run is on. The work board's clock and main's `busySince` read it.
	 */
	since?: number;
}

/** A {@link RunState} as another side reads it (the remote `run` tab event, `TabRunArg`). */
export interface RunReading {
	running: boolean;
	turn: boolean;
	compacting?: boolean;
	elapsedMs?: number;
}

/** A fresh spawn's state, and what a restart or crash leaves: the run dies with the process. */
export function idleRun(): RunState {
	return { running: false, awaitingSettled: false, turn: false, retrying: false, endedWhileRetrying: false };
}

export function runBusy(run: RunState): boolean {
	return run.running || run.compacting === true;
}

/**
 * The run is still on only because stock reports background work (subagents, async jobs, a queued wake) that can
 * wake the session: its turn ended. Tab info's `settling`; the session cards draw it as `background`.
 */
export function runSettling(run: RunState): boolean {
	return run.running && !run.turn;
}

/**
 * How a run stands, for a party that saw none of its events: a device re-attaching to a paired host's tab, a window
 * joining a tab another one runs. The start goes as elapsed time, since no clock between two computers is shared.
 */
export function runReading(run: RunState, now = Date.now()): RunReading {
	return {
		running: run.running,
		turn: run.turn,
		...(run.compacting !== undefined ? { compacting: run.compacting } : {}),
		...(run.since !== undefined ? { elapsedMs: Math.max(0, now - run.since) } : {}),
	};
}

/** The run a {@link runReading} describes; `kept` is this side's own reading, whose pending settlement survives. */
export function runFromReading(reading: RunReading, kept?: RunState, now = Date.now()): RunState {
	return {
		running: reading.running,
		turn: reading.turn,
		awaitingSettled:
			reading.running && (!reading.turn || (kept !== undefined && runBusy(kept) && kept.awaitingSettled)),
		retrying: false,
		endedWhileRetrying: false,
		...(reading.compacting !== undefined ? { compacting: reading.compacting } : {}),
		...(reading.running
			? { since: reading.elapsedMs !== undefined ? now - reading.elapsedMs : (kept?.since ?? now) }
			: {}),
	};
}

/** `prompt_result.sessionSettled` / `session_settled`: background work keeps the run alive until settled. */
export function settleRun(run: RunState, settled: boolean): void {
	run.awaitingSettled = !settled;
	run.running = !settled;
	if (settled) {
		run.turn = false;
		delete run.since;
	} else run.since ??= Date.now();
}

/**
 * Apply one agent event. True when it ended the run's last attempt — an
 * agent_end outside a retry saga, or a failed auto_retry_end after the saga's
 * agent_end; the session may still be awaiting settlement.
 */
export function applyRunEvent(run: RunState, event: AgentSessionEvent, now = Date.now()): boolean {
	switch (event.type) {
		case "agent_start":
			run.running = true;
			run.turn = true;
			run.since = now;
			return false;
		case "agent_end":
			// The saga's coalesced agent_end can arrive before its auto_retry_end;
			// only that end event says whether the run is over.
			if (run.retrying) {
				run.endedWhileRetrying = true;
				return false;
			}
			run.turn = false;
			if (!run.awaitingSettled) {
				run.running = false;
				delete run.since;
			}
			return true;
		case "auto_retry_start":
			run.retrying = true;
			return false;
		case "auto_retry_end": {
			const failedAfterEnd = !event.success && run.endedWhileRetrying;
			run.retrying = false;
			run.endedWhileRetrying = false;
			if (failedAfterEnd) run.turn = false;
			if (failedAfterEnd && !run.awaitingSettled) {
				run.running = false;
				delete run.since;
			}
			return failedAfterEnd;
		}
		case "auto_compaction_start":
			run.compacting = true;
			return false;
		case "auto_compaction_end":
			run.compacting = false;
			return false;
		default:
			return false;
	}
}

/** A tab's run state plus what the resume rules read from it (turn-resume.ts `ResumeFact`). */
export interface RunTracking {
	run: RunState;
	/** How the last finished run ended; cleared when the next run starts. */
	lastRun?: IpcTabRunOutcome;
	/** The user pressed Stop since the run began: a relaunch must not resume it. Cleared by the next agent_start. */
	stopped?: boolean;
	/** Stock's auto-retry waiting for its next attempt: set by `auto_retry_start`, cleared by its end or a new run. */
	retry?: { errorMessage: string };
}

/** {@link applyRunEvent} plus the run's outcome, Stop and pending auto-retry; true when it ended the run's last attempt. */
export function trackRunEvent(tab: RunTracking, event: AgentSessionEvent): boolean {
	const ended = applyRunEvent(tab.run, event);
	if (event.type === "agent_start") {
		tab.lastRun = undefined;
		tab.stopped = false;
		tab.retry = undefined;
	} else if (event.type === "auto_retry_start") {
		// News for the resume rules: offline, the wait takes stock's retry over (turn-resume.ts).
		tab.retry = { errorMessage: event.errorMessage };
	} else if (ended && event.type === "agent_end") {
		if (event.isTerminal !== false) tab.lastRun = runOutcome(event.messages);
	} else if (event.type === "auto_retry_end") {
		tab.retry = undefined;
		if (ended) tab.lastRun = { stopReason: "error", errorMessage: event.finalError };
	}
	return ended;
}

/**
 * Characters of a finished reply's text kept for the completion banner, which reads only
 * its opening prose (renderer `notificationSummary`, 160 characters after Markdown and code
 * are dropped); the cap keeps a long reply out of every later TAB_STATUS.
 */
const RUN_REPLY_PREVIEW_CHARS = 4000;

/** A finished run's outcome, read from agent_end's own messages (the last assistant reply). */
function runOutcome(messages: AgentMessage[] | undefined): IpcTabRunOutcome {
	const last = messages?.findLast(message => message.role === "assistant");
	const stopReason = typeof last?.stopReason === "string" ? last.stopReason : "stop";
	if (typeof last?.errorMessage === "string" && last.errorMessage)
		return { stopReason, errorMessage: last.errorMessage };
	const content = last?.content;
	const text = (
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n")
				: ""
	).trim();
	return text ? { stopReason, reply: text.slice(0, RUN_REPLY_PREVIEW_CHARS) } : { stopReason };
}
