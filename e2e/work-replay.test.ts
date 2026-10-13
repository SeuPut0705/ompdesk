import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkReplay, type RecordedWorkFrame } from "./work-recording";

const recording: RecordedWorkFrame[] = [0, 10, 20, 30, 40, 50, 60, 70].map(atMs => ({
	channel: "main",
	atMs,
	events: [],
}));

describe("recorded work replay", () => {
	let emitted: number[];
	let replay: () => Promise<boolean>;
	beforeEach(() => {
		vi.useFakeTimers();
		emitted = [];
		replay = createWorkReplay(
			recording,
			[2, 4],
			frame => emitted.push(recording.indexOf(frame)),
			ms => {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, ms);
				return promise;
			},
		);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("queues an advance that arrives mid-segment instead of replaying ahead", async () => {
		const first = replay();
		await vi.advanceTimersByTimeAsync(15);
		expect(emitted).toEqual([0, 1]);
		// The e2e advances as soon as it sees the live surface, often before the
		// opening segment has drained: that must play the next segment, not the rest.
		const second = replay();
		await vi.runAllTimersAsync();
		expect(emitted).toEqual([0, 1, 2, 3, 4]);
		await expect(first).resolves.toBe(false);
		await expect(second).resolves.toBe(false);
	});

	it("never repeats, skips or reorders frames when the final advances overlap", async () => {
		void replay();
		await vi.runAllTimersAsync();
		void replay();
		await vi.advanceTimersByTimeAsync(5);
		const last = replay();
		const extra = replay();
		await vi.runAllTimersAsync();
		// A stale progress frame replayed after completion would erase the agent's conclusion.
		expect(emitted).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		await expect(last).resolves.toBe(true);
		await expect(extra).resolves.toBe(false);
	});
});
