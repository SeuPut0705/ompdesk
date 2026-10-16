import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { isLiveSubagentStatus } from "../../panels/subagent-graph";

/** `turn`: the main turn runs (Stop). `background`: it is idle but this tab's agents or shells still work (Send). */
export type ComposerLiveState = "turn" | "background";

/** Subagents that are live but waiting for a follow-up, not working (the work board's own split). */
const WAITING_AGENT: Record<string, true> = { parked: true, idle: true };

export function workingAgentCount(subagents: Iterable<SubagentSnapshot>): number {
	let count = 0;
	for (const agent of subagents) if (isLiveSubagentStatus(agent.status) && !WAITING_AGENT[agent.status]) count++;
	return count;
}

/** A waiting question or approval wins over both states; between turns only real background work counts. */
export function composerLiveState(input: {
	streaming: boolean;
	waiting: number;
	background: number;
}): ComposerLiveState | null {
	if (input.waiting > 0) return null;
	if (input.streaming) return "turn";
	return input.background > 0 ? "background" : null;
}
