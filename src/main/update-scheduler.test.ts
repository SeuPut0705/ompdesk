import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type Backoff,
	CHECK_INTERVAL_MS,
	MAX_CHECK_INTERVAL_MS,
	nextCheckDelay,
	settleBackoff,
	UPDATE_STEP_MAX_MS,
	UpdateScheduler,
} from "./update-scheduler";

const HOUR = 60 * 60 * 1000;

afterEach(() => {
	vi.useRealTimers();
});

describe("nextCheckDelay", () => {
	it("is a few hours while all is well, doubles per failure in a row, and stops at a day", () => {
		expect(nextCheckDelay(0)).toBe(CHECK_INTERVAL_MS);
		expect(CHECK_INTERVAL_MS).toBe(4 * HOUR);
		expect(nextCheckDelay(1)).toBe(8 * HOUR);
		expect(nextCheckDelay(2)).toBe(16 * HOUR);
		expect(nextCheckDelay(3)).toBe(MAX_CHECK_INTERVAL_MS);
		expect(nextCheckDelay(50)).toBe(MAX_CHECK_INTERVAL_MS);
	});
});

describe("settleBackoff", () => {
	it("counts failures in a row into the next due time, and clears both on anything else", () => {
		const item: Backoff = { failures: 0, nextAt: 0 };
		settleBackoff(item, true, 1000);
		expect(item).toEqual({ failures: 1, nextAt: 1000 + 8 * HOUR });
		settleBackoff(item, true, 2000);
		expect(item).toEqual({ failures: 2, nextAt: 2000 + 16 * HOUR });
		settleBackoff(item, false, 3000);
		expect(item).toEqual({ failures: 0, nextAt: 0 });
	});
});

describe("UpdateScheduler", () => {
	it("ticks at start in a scheduled launch, then one delay after each tick ends, until disposed", async () => {
		vi.useFakeTimers();
		let ticks = 0;
		const scheduler = new UpdateScheduler({
			scheduled: true,
			tick: async () => {
				ticks++;
			},
			delay: () => HOUR * ticks,
		});
		expect(scheduler.start()).toBe(true);
		expect(scheduler.start()).toBe(false);
		expect(scheduler.started).toBe(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(ticks).toBe(1);
		await vi.advanceTimersByTimeAsync(HOUR);
		expect(ticks).toBe(2);
		await vi.advanceTimersByTimeAsync(2 * HOUR - 1);
		expect(ticks).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(ticks).toBe(3);
		scheduler.dispose();
		expect(scheduler.disposed).toBe(true);
		await vi.advanceTimersByTimeAsync(MAX_CHECK_INTERVAL_MS);
		expect(ticks).toBe(3);
	});

	it("waits CHECK_INTERVAL_MS by default, keeps going after a rejected tick, and a tick now drops the pending timer", async () => {
		vi.useFakeTimers();
		let ticks = 0;
		const scheduler = new UpdateScheduler({
			scheduled: true,
			tick: async () => {
				ticks++;
				if (ticks === 1) throw new Error("no shell env");
			},
		});
		scheduler.start();
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
		expect(ticks).toBe(2);
		await vi.advanceTimersByTimeAsync(HOUR);
		await scheduler.tick();
		expect(ticks).toBe(3);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
		expect(ticks).toBe(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(ticks).toBe(4);
		scheduler.dispose();
	});

	it("an unscheduled launch starts without a tick; after dispose it never starts", async () => {
		vi.useFakeTimers();
		const tick = vi.fn(async () => {});
		const unscheduled = new UpdateScheduler({ scheduled: false, tick });
		expect(unscheduled.start()).toBe(true);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(tick).not.toHaveBeenCalled();
		const disposed = new UpdateScheduler({ scheduled: true, tick });
		disposed.dispose();
		expect(disposed.start()).toBe(false);
		expect(disposed.started).toBe(false);
		await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
		expect(tick).not.toHaveBeenCalled();
	});

	it("queues work one at a time, rejects with a job's error without stopping the queue, and drops jobs once disposed", async () => {
		const scheduler = new UpdateScheduler({ scheduled: false, tick: async () => {} });
		const gate = Promise.withResolvers<void>();
		const order: string[] = [];
		const first = scheduler.enqueue(async () => {
			order.push("first");
			await gate.promise;
			order.push("first done");
		});
		const failing = scheduler.enqueue(async () => {
			order.push("failing");
			throw new Error("boom");
		});
		const third = scheduler.enqueue(async () => {
			order.push("third");
		});
		gate.resolve();
		await first;
		await expect(failing).rejects.toThrow("boom");
		await third;
		expect(order).toEqual(["first", "first done", "failing", "third"]);

		const held = Promise.withResolvers<void>();
		const running = scheduler.enqueue(() => held.promise);
		const dropped = vi.fn(async () => {});
		const queued = scheduler.enqueue(dropped);
		scheduler.dispose();
		held.resolve();
		await running;
		await queued;
		await scheduler.enqueue(dropped);
		expect(dropped).not.toHaveBeenCalled();
	});

	it("a pass that never settles does not keep the next one waiting", async () => {
		vi.useFakeTimers();
		const scheduler = new UpdateScheduler({ scheduled: false, tick: async () => {} });
		const hung = scheduler.enqueue(() => Promise.withResolvers<void>().promise).then(
			() => null,
			error => error,
		);
		const ran = vi.fn(async () => {});
		const next = scheduler.enqueue(ran);
		await vi.advanceTimersByTimeAsync(UPDATE_STEP_MAX_MS);
		expect(((await hung) as Error).name).toBe("StepStalledError");
		await next;
		expect(ran).toHaveBeenCalledOnce();
		scheduler.dispose();
	});
});
