import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../shared/rpc-types";
import {
	countTogether,
	MODEL_WAIT_TOGETHER_MS,
	type ModelWaitRecord,
	ModelWaitTracker,
	type ProviderCounts,
} from "./model-wait-count";

const rec = (key: string, provider: string, since: number, scope = ""): ModelWaitRecord => ({
	key,
	scope,
	provider,
	since,
});
const sent = (provider?: string) =>
	({ type: "model_request", phase: "sent", ...(provider ? { provider } : {}) }) as AgentSessionEvent;
const answered = { type: "model_request", phase: "answered" } as AgentSessionEvent;

describe("countTogether", () => {
	const now = 100_000;
	const due = now - MODEL_WAIT_TOGETHER_MS;

	it("counts sessions of one provider whose request went unanswered for 30 s, when two or more", () => {
		const counts = countTogether(
			[rec("a", "anthropic", due), rec("b", "anthropic", 0), rec("c", "anthropic", due)],
			now,
		);
		expect([...counts]).toEqual([
			["a", 3],
			["b", 3],
			["c", 3],
		]);
	});

	it("leaves out a request younger than 30 s, a lone waiter, another provider and a frame without a provider", () => {
		const records = [
			rec("fresh", "anthropic", due + 1),
			rec("old", "anthropic", due),
			rec("other", "openai", due),
			rec("none", "", due),
			rec("none2", "", due),
		];
		expect(countTogether(records, now).size).toBe(0);
		expect([...countTogether([...records, rec("old2", "anthropic", 0)], now)]).toEqual([
			["old", 2],
			["old2", 2],
		]);
	});

	it("takes a paired host's own count for a tab it runs, and keeps the scopes apart", () => {
		const records = [
			rec("remote", "anthropic", due, "dev"),
			rec("local", "anthropic", due),
			rec("local2", "anthropic", due),
		];
		const host = new Map<string, ProviderCounts>([["dev", { anthropic: 4 }]]);
		expect([...countTogether(records, now, host)]).toEqual([
			["remote", 4],
			["local", 2],
			["local2", 2],
		]);
		// An older host sends none: the remote tab is alone in its scope as far as this computer sees.
		expect([...countTogether(records, now)]).toEqual([
			["local", 2],
			["local2", 2],
		]);
		// A host with a single waiter leaves the tab alone.
		expect(
			countTogether([rec("remote", "anthropic", due, "dev")], now, new Map([["dev", { anthropic: 1 }]])).size,
		).toBe(0);
	});
});

describe("ModelWaitTracker", () => {
	function make() {
		const timers: { run: () => void; ms: number }[] = [];
		let now = 0;
		const tracker = new ModelWaitTracker({
			now: () => now,
			setTimer: (run, ms) => {
				const timer = { run, ms };
				timers.push(timer);
				return timer;
			},
			clearTimer: handle => {
				const at = timers.indexOf(handle as (typeof timers)[number]);
				if (at >= 0) timers.splice(at, 1);
			},
		});
		const changes = vi.fn();
		tracker.onChange(changes);
		return {
			tracker,
			timers,
			changes,
			advance(ms: number) {
				now += ms;
				for (const timer of [...timers]) if (timer.ms <= ms) timer.run();
			},
		};
	}

	it("tells every tab once two have waited 30 s, and takes it back when one is answered", () => {
		const { tracker, advance, changes } = make();
		tracker.observe("a", "", [sent("anthropic")]);
		advance(10_000);
		tracker.observe("b", "", [sent("anthropic")]);
		advance(20_000);
		// a is 30 s old, b only 20 s: nobody waits together yet.
		expect(tracker.snapshot.together.size).toBe(0);
		advance(10_000);
		expect([...tracker.snapshot.together]).toEqual([
			["a", 2],
			["b", 2],
		]);
		expect(tracker.snapshot.local).toEqual({ anthropic: 2 });
		const calls = changes.mock.calls.length;
		tracker.observe("a", "", [answered]);
		expect(tracker.snapshot.together.size).toBe(0);
		expect(tracker.snapshot.local).toEqual({ anthropic: 1 });
		expect(changes.mock.calls.length).toBe(calls + 1);
	});

	it("ends a wait on the first output, the run's end or start, and when the tab goes away", () => {
		const { tracker, advance } = make();
		for (const key of ["a", "b", "c", "d"]) tracker.observe(key, "", [sent("anthropic")]);
		advance(MODEL_WAIT_TOGETHER_MS);
		expect(tracker.snapshot.together.size).toBe(4);
		tracker.observe("a", "", [{ type: "message_update" } as AgentSessionEvent]);
		tracker.observe("b", "", [{ type: "agent_end" } as AgentSessionEvent]);
		expect(tracker.snapshot.together.size).toBe(2);
		tracker.forget("c");
		expect(tracker.snapshot.together.size).toBe(0);
	});

	it("keeps a repeated request's first time and follows a host's count", () => {
		const { tracker, advance } = make();
		tracker.observe("r", "dev", [sent("anthropic")]);
		advance(15_000);
		tracker.observe("r", "dev", [sent("anthropic")]);
		advance(15_000);
		expect(tracker.snapshot.together.size).toBe(0);
		tracker.setHostCounts("dev", { anthropic: 3 });
		expect([...tracker.snapshot.together]).toEqual([["r", 3]]);
		// The tab runs elsewhere: this computer's own count says nothing about it.
		expect(tracker.snapshot.local).toEqual({});
		tracker.setHostCounts("dev", undefined);
		expect(tracker.snapshot.together.size).toBe(0);
	});
});
