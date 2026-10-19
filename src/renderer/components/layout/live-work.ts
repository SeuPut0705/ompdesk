/**
 * Whether a session's work is going on, and where: the one rule behind every `LiveEdge` that shows a session (the
 * composer box, a sidebar session row, a split pane's header). `turn`: its own turn runs. `background`: the turn is
 * idle but work it started still runs behind it (its subagents, its background shells, the sessions its agent opened
 * that run now). A question or approval waiting on the person wins over both: that card owns the attention.
 */
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import type { LiveEdgeState } from "../common/LiveEdge";
import { isLiveSubagentStatus } from "../panels/subagent-graph";

/** Subagents that are live but waiting for a follow-up, not working (the work board's own split). */
const WAITING_AGENT: Record<string, true> = { parked: true, idle: true };

export function workingAgentCount(subagents: Iterable<SubagentSnapshot>): number {
	let count = 0;
	for (const agent of subagents) if (isLiveSubagentStatus(agent.status) && !WAITING_AGENT[agent.status]) count++;
	return count;
}

/** `background` counts the agents, shells and opened sessions that still work behind an idle turn. */
export function liveWorkState(input: {
	streaming: boolean;
	waiting: number;
	background: number;
}): LiveEdgeState | null {
	if (input.waiting > 0) return null;
	if (input.streaming) return "turn";
	return input.background > 0 ? "background" : null;
}
