import { describe, expect, it } from "vitest";
import { JOB_GATE_MAX_LEASE_MS, JobGate, type JobGateTimers } from "./job-gate";

/** Timers the test fires by hand: `fire()` runs every pending one and says how long each was set for. */
function manualTimers() {
	const pending = new Map<number, { run: () => void; ms: number }>();
	let next = 0;
	const timers: JobGateTimers = {
		set: (run, ms) => {
			pending.set(++next, { run, ms });
			return next;
		},
		clear: handle => pending.delete(handle as number),
	};
	return {
		timers,
		durations: () => [...pending.values()].map(timer => timer.ms),
		fire() {
			const due = [...pending.values()];
			pending.clear();
			for (const timer of due) timer.run();
		},
	};
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false;
	void promise.then(() => {
		done = true;
	});
	for (let i = 0; i < 5; i++) await Promise.resolve();
	return done;
}

describe("JobGate (the automatic update's last look and quit as one step)", () => {
	it("holds every tool call that reaches it while frozen, and lets it run once thawed", async () => {
		const gate = new JobGate(manualTimers().timers);
		expect(gate.freeze(false, 10_000)).toEqual({ frozen: true, starting: 0 });
		const call = gate.enter("call-1", "Main");
		expect(await settled(call)).toBe(false);
		expect(gate.thaw()).toBe(true);
		expect(await settled(call)).toBe(true);
		expect(gate.thaw()).toBe(false);
	});

	it("never freezes while a job runs", () => {
		const gate = new JobGate(manualTimers().timers);
		expect(gate.freeze(true, 10_000)).toEqual({ frozen: false, starting: 0 });
		expect(gate.frozen).toBe(false);
	});

	// A call already past the gate can still register a job after the look (a `task`, a `bash` that goes to the
	// background): the freeze waits for a moment with none under way, or the look and the quit are not one step.
	it("never freezes while a tool call past the gate is under way; freezes once it ended", async () => {
		const gate = new JobGate(manualTimers().timers);
		await gate.enter("call-1", "Main");
		expect(gate.freeze(false, 10_000)).toEqual({ frozen: false, starting: 1 });
		gate.leave("call-1");
		expect(gate.freeze(false, 10_000)).toEqual({ frozen: true, starting: 0 });
	});

	it("forgets the calls of an agent whose loop ended, whatever events a failure skipped", async () => {
		const gate = new JobGate(manualTimers().timers);
		await gate.enter("call-1", "Main");
		await gate.enter("call-2", "0-Explore");
		gate.agentEnded("Main");
		expect(gate.freeze(false, 10_000)).toEqual({ frozen: false, starting: 1 });
		gate.agentEnded("0-Explore");
		expect(gate.freeze(false, 10_000).frozen).toBe(true);
	});

	it("opens by itself when the lease ends, never later than stock's 30 s tool_call handler timeout", async () => {
		const clock = manualTimers();
		const gate = new JobGate(clock.timers);
		gate.freeze(false, 10 * 60_000);
		expect(clock.durations()).toEqual([JOB_GATE_MAX_LEASE_MS]);
		expect(JOB_GATE_MAX_LEASE_MS).toBeLessThan(30_000);
		const call = gate.enter("call-1", "Main");
		clock.fire();
		expect(await settled(call)).toBe(true);
		expect(gate.frozen).toBe(false);
	});

	it("a second freeze renews the lease instead of stacking a second one", () => {
		const clock = manualTimers();
		const gate = new JobGate(clock.timers);
		gate.freeze(false, 5000);
		gate.freeze(false, 8000);
		expect(clock.durations()).toEqual([8000]);
	});
});
