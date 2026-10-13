/**
 * A tab's turn state, read from its sidecar's events. The local pool and the
 * tabs this machine hosts for paired devices share it, so "running" means the
 * same thing on every machine.
 */
import type { AgentSessionEvent } from "../shared/rpc-types";

export interface RunState {
	/** agent_start seen, its run not yet over. */
	running: boolean;
	/** The prompt yielded while background work can still wake the session. */
	awaitingSettled: boolean;
	/** Inside an auto-retry saga: its coalesced agent_end is not the end of the run. */
	retrying: boolean;
	/** The saga's coalesced agent_end arrived while the retry was still outstanding. */
	endedWhileRetrying: boolean;
	/** Automatic compaction state once observed since the spawn; true blocks session mutation. */
	compacting?: boolean;
}

/** A fresh spawn's state, and what a restart or crash leaves: the run dies with the process. */
export function idleRun(): RunState {
	return { running: false, awaitingSettled: false, retrying: false, endedWhileRetrying: false };
}

export function runBusy(run: RunState): boolean {
	return run.running || run.compacting === true;
}

/** `prompt_result.sessionSettled` / `session_settled`: background work keeps the run alive until settled. */
export function settleRun(run: RunState, settled: boolean): void {
	run.awaitingSettled = !settled;
	run.running = !settled;
}

/**
 * Apply one agent event. True when it ended the run's last attempt — an
 * agent_end outside a retry saga, or a failed auto_retry_end after the saga's
 * agent_end; the session may still be awaiting settlement.
 */
export function applyRunEvent(run: RunState, event: AgentSessionEvent): boolean {
	switch (event.type) {
		case "agent_start":
			run.running = true;
			return false;
		case "agent_end":
			// The saga's coalesced agent_end can arrive before its auto_retry_end;
			// only that end event says whether the run is over.
			if (run.retrying) {
				run.endedWhileRetrying = true;
				return false;
			}
			if (!run.awaitingSettled) run.running = false;
			return true;
		case "auto_retry_start":
			run.retrying = true;
			return false;
		case "auto_retry_end": {
			const failedAfterEnd = !event.success && run.endedWhileRetrying;
			run.retrying = false;
			run.endedWhileRetrying = false;
			if (failedAfterEnd && !run.awaitingSettled) run.running = false;
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
