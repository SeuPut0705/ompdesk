import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../shared/rpc-types";
import { applyRunEvent, idleRun, type RunState, runFromReading, runReading } from "./sidecar-run-state";

const START = {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 2_000,
	errorMessage: "The socket connection was closed unexpectedly before the response completed",
} as const satisfies AgentSessionEvent;

function running(events: AgentSessionEvent[], now = 1_000): RunState {
	const run = idleRun();
	for (const event of [{ type: "agent_start" } as AgentSessionEvent, ...events]) applyRunEvent(run, event, now);
	return run;
}

describe("a retry saga across a reading", () => {
	// 25 Oct 2026: a paired desktop joined the host's turn while stock's retried request waited 55 s for its first
	// byte. Its reading had no saga, so the failed attempt read as the turn's end and its failure card stayed up.
	it("goes with the reading, its start as elapsed time on the reader's clock", () => {
		const reading = runReading(running([START], 1_000), 4_000);
		expect(reading.saga).toEqual({
			attempt: 1,
			maxAttempts: 3,
			delayMs: 2_000,
			errorMessage: START.errorMessage,
			elapsedMs: 3_000,
			ended: false,
		});
		expect(runFromReading(reading, undefined, 50_000).saga).toEqual({
			attempt: 1,
			maxAttempts: 3,
			delayMs: 2_000,
			errorMessage: START.errorMessage,
			startedAt: 47_000,
		});
		expect(runReading(running([]))).not.toHaveProperty("saga");
	});

	it("keeps a joined run going through the saga's coalesced agent_end, until stock's retry answered", () => {
		const joined = runFromReading(runReading(running([START])));
		expect(applyRunEvent(joined, { type: "agent_end", messages: [], isTerminal: false })).toBe(false);
		expect(applyRunEvent(joined, { type: "agent_start" })).toBe(false);
		expect(joined).toMatchObject({ running: true, turn: true });
		expect(applyRunEvent(joined, { type: "auto_retry_end", success: true, attempt: 1 })).toBe(false);
		expect(joined.saga).toBeUndefined();
		expect(applyRunEvent(joined, { type: "agent_end", messages: [] })).toBe(true);
		expect(joined.running).toBe(false);
	});

	it("ends a run joined after the saga's agent_end once stock gives up", () => {
		const reading = runReading(running([START, { type: "agent_end", messages: [], isTerminal: false }]));
		expect(reading.saga?.ended).toBe(true);
		const joined = runFromReading(reading);
		expect(applyRunEvent(joined, { type: "auto_retry_end", success: false, attempt: 3, finalError: "gone" })).toBe(
			true,
		);
		expect(joined).toMatchObject({ running: false, turn: false });
	});

	it("carries no saga for a run that is not on", () => {
		const reading = { running: false, turn: false, saga: { ...START, elapsedMs: 0, ended: false } };
		expect(runFromReading(reading)).not.toHaveProperty("saga");
	});
});
