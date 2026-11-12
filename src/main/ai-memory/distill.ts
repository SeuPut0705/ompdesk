/**
 * Turning a stretch of a person's conversation into the few durable pages worth keeping (decisions, rules, gotchas,
 * procedures, and the owner's preferences and corrections, which hold in every project) is the core's
 * (`native/ompdesk/crates/core/src/upkeep/distill.rs`): what is read, what is asked, what is accepted.
 *
 * Kept for curate.ts and memory-judge.ts until 7d moves them (this batch): `GLOBAL_PROJECT`, `DistillMessage`.
 */

// kept for curate.ts until 7d moves it (this batch)
/** `_global`: the reserved project ai-memory's `memory_query` unions into every project's default recall. */
export const GLOBAL_PROJECT = { workspace: "default", project: "_global" } as const;

// kept for memory-judge.ts until 7d moves it (this batch)
/** The system prompt and the text on stdin of one model call. */
export interface DistillMessage {
	system: string;
	user: string;
}
