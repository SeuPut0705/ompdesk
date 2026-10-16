import { Check, Minus, X } from "lucide-react";
import { cx } from "../../../lib/format";
import type { ToolEntry } from "../../../stores/tools";
import { statusMeta } from "../../panels/subagent-graph";

export type WorkState = "running" | "pending" | "complete" | "failed" | "stopped";

/** How a work group (or one agent's lane) ended, resolved once by its owner. */
export type WorkGroupState = "running" | "failed" | "interrupted" | "complete";

export function agentGroupState(status: string | undefined): WorkGroupState {
	const meta = statusMeta(status ?? "");
	if (meta.live) return "running";
	if (meta.variant === "error") return "failed";
	if (meta.variant === "success") return "complete";
	return "interrupted";
}

/** One subagent of a group, with how its parent task call itself ended. */
export interface GroupAgent {
	status: string;
	parent: "running" | "failed" | "interrupted" | "done";
}

export interface WorkGroupTally {
	/** The turn is still producing this group (model streaming or preparing a step). */
	live: boolean;
	runningTools: number;
	failedTools: number;
	/** Failures reported for the group outside its tool entries. */
	reportedFailures: number;
	interruptedTools: number;
	agents: readonly GroupAgent[];
	/**
	 * A later work card exists in the session: this one is resolved. Its unfinished calls
	 * were cut off; agents still running report on their own lanes, never as this card's state.
	 */
	superseded?: boolean;
	/**
	 * Stock's empty aborted reply follows the group: the user stopped the run. A stop while the
	 * model's next request was pending cuts no call, yet the run did not complete.
	 */
	stopped?: boolean;
}

export interface WorkGroupResolution {
	state: WorkGroupState;
	failed: number;
	interrupted: number;
	runningAgents: number;
}

/**
 * The single rule for how a work group stands. Detached stock tasks return
 * before their agents finish, so an agent's own end counts too, except when
 * its parent call already reported the same failure or interruption.
 */
export function resolveWorkGroup(tally: WorkGroupTally): WorkGroupResolution {
	let runningAgents = 0;
	let failed = tally.failedTools + tally.reportedFailures;
	let interrupted = tally.interruptedTools + (tally.superseded ? tally.runningTools : 0);
	for (const agent of tally.agents) {
		const state = agentGroupState(agent.status);
		if (state === "running") runningAgents += tally.superseded ? 0 : 1;
		else if (state === "failed" && agent.parent !== "failed") failed++;
		else if (state === "interrupted" && agent.parent !== "interrupted" && agent.parent !== "failed") interrupted++;
	}
	const live = !tally.superseded && (tally.live || tally.runningTools > 0);
	const state: WorkGroupState =
		live || runningAgents > 0
			? "running"
			: failed > 0
				? "failed"
				: interrupted > 0 || tally.stopped
					? "interrupted"
					: "complete";
	return { state, failed, interrupted, runningAgents };
}

/**
 * Stock agent-loop.ts emits an empty aborted reply with Date.now() after a
 * tool stop, but preserves partial content and its timestamp for a model stop.
 * Only the former supplies stoppedAt. Explicit aborted calls are interrupted
 * regardless of isError; a live turn without that reply keeps ordinary errors.
 */
export function isInterruptedError(
	entry: Pick<ToolEntry, "status" | "isError" | "endTime">,
	stoppedAt?: number,
): boolean {
	return (
		entry.status === "aborted" ||
		((entry.status === "error" || entry.isError) &&
			stoppedAt !== undefined &&
			entry.endTime !== null &&
			entry.endTime >= stoppedAt - 1000)
	);
}

/** Preserve the queued ring; map the canonical agent outcome for every other status. */
export function agentWorkState(status: string | undefined): WorkState {
	if (status === "pending") return "pending";
	const state = agentGroupState(status);
	return state === "interrupted" ? "stopped" : state;
}

/**
 * One status mark shared by the work head and agent lanes: a breathing accent
 * dot while running (static under reduced motion), a hollow ring while queued,
 * then a check, a cross or a dash. The label carries the state for assistive tech.
 */
export function WorkStatus({ state, label, motion }: { state: WorkState; label: string; motion: boolean }) {
	return (
		<span
			className={cx("omp-work-status", motion && state === "running" && "omp-work-pulse")}
			data-state={state}
			role="img"
			aria-label={label}
			title={label}
		>
			{state === "complete" ? (
				<Check aria-hidden />
			) : state === "failed" ? (
				<X aria-hidden />
			) : state === "stopped" ? (
				<Minus aria-hidden />
			) : null}
		</span>
	);
}
