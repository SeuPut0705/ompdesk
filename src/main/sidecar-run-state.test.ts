import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../shared/rpc-types";
import {
	applyRunEvent,
	idleRun,
	type RunReading,
	type RunState,
	type RunTracking,
	runFromReading,
	runReading,
	settleRun,
	trackRunEvent,
} from "./sidecar-run-state";

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

/**
 * The pool's run rules moved into the core (`crates/core/src/pool/run.rs`); this file stays for `remote/host-services.ts`,
 * which reads the same rules synchronously until the remote host moves. One table pins both: event sequences, and the
 * state every step must leave (`run-captured.json`, captured from this file's functions; the Rust test replays it).
 */
describe("the captured table of event sequences", () => {
	type Step = {
		op: "event" | "settle" | "reading" | "fromReading" | "stop";
		now: number;
		event?: AgentSessionEvent;
		settled?: boolean;
		keep?: boolean;
		reading?: RunReading;
		expect: Record<string, unknown>;
	};
	const table = JSON.parse(
		readFileSync(new URL("../../native/ompdesk/crates/core/src/pool/run-captured.json", import.meta.url), "utf8"),
	) as { cases: Array<{ name: string; steps: Step[] }> };
	const plain = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

	it("gives the state the table holds after every step", () => {
		let steps = 0;
		for (const { name, steps: list } of table.cases) {
			const tab: RunTracking = { run: idleRun() };
			for (const step of list) {
				const got: Record<string, unknown> = {};
				if (step.op === "event" && step.event) {
					vi.spyOn(Date, "now").mockReturnValue(step.now);
					got.ended = trackRunEvent(tab, structuredClone(step.event));
				} else if (step.op === "settle") {
					vi.spyOn(Date, "now").mockReturnValue(step.now);
					settleRun(tab.run, step.settled === true);
				} else if (step.op === "reading") got.reading = plain(runReading(tab.run, step.now));
				else if (step.op === "fromReading" && step.reading)
					tab.run = runFromReading(structuredClone(step.reading), step.keep ? tab.run : undefined, step.now);
				else if (step.op === "stop") tab.stopped = true;
				Object.assign(got, {
					run: plain(tab.run),
					lastRun: plain(tab.lastRun),
					stopped: tab.stopped === true,
					retry: plain(tab.retry),
				});
				expect(got, `${name}: ${JSON.stringify(step)}`).toEqual(step.expect);
				steps++;
			}
		}
		vi.restoreAllMocks();
		expect(steps).toBeGreaterThan(1000);
	});
});
