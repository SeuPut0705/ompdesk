/**
 * Whether a session's work is going on, and where: the one rule behind every working cue that shows a session (the
 * composer box's sweep, a sidebar session row's title, a split pane's header title). `turn`: its own turn runs.
 * `background`: the turn is idle but work it started still runs behind it (its subagents, its background shells, the
 * sessions its agent opened that run now). `waiting`: a question or approval waits on the person; it wins over both,
 * and the cue holds a still warning colour instead of the sweep.
 */
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import type { LiveState } from "../common/LiveShimmer";
import { isLiveSubagentStatus } from "../panels/subagent-graph";

/** Subagents that are live but waiting for a follow-up, not working (the work board's own split). */
const WAITING_AGENT: Record<string, true> = { parked: true, idle: true };

export function workingAgentCount(subagents: Iterable<SubagentSnapshot>): number {
	let count = 0;
	for (const agent of subagents) if (isLiveSubagentStatus(agent.status) && !WAITING_AGENT[agent.status]) count++;
	return count;
}

/** `background` counts the agents, shells and opened sessions that still work behind an idle turn. */
export function liveWorkState(input: { streaming: boolean; waiting: number; background: number }): LiveState | null {
	if (input.waiting > 0) return "waiting";
	if (input.streaming) return "turn";
	return input.background > 0 ? "background" : null;
}
