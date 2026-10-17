import type { AgentSessionEvent, SubagentFrame } from "../src/shared/rpc-types";

/** One wire frame the real-omp audits record (`real-work-map`, `real-advisor`), with its offset from the start. */
export type RecordedWorkFrame =
	| { atMs: number; channel: "main"; events: AgentSessionEvent[] }
	| { atMs: number; channel: "subagent"; frame: SubagentFrame };
