import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	currentStepSignal,
	fencedCall,
	SerialChain,
	StepStalledError,
	stepStalled,
	throwIfStepStalled,
} from "./serial-chain";

const NEVER = () => Promise.withResolvers<never>().promise;

/** A step that ends `ms` of fake time after it starts. */
function elapse(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

describe("SerialChain", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function chain(overrides: { onStall?: (stall: StepStalledError) => void } = {}) {
		const stalls: StepStalledError[] = [];
		const serial = new SerialChain({
			name: "test",
			maxStepMs: 1000,
			log: stall => stalls.push(stall),
			...overrides,
		});
		return { serial, stalls };
	}

	it("runs steps one at a time, in order", async () => {
		const { serial } = chain();
		const order: string[] = [];
		const first = serial.run(async () => {
			order.push("a start");
			await Promise.resolve();
			order.push("a end");
			return 1;
		});
		const second = serial.run(async () => {
			order.push("b");
			return 2;
		});
		expect(await Promise.all([first, second])).toEqual([1, 2]);
		expect(order).toEqual(["a start", "a end", "b"]);
	});

	it("a step that never settles fails its caller and the next step runs", async () => {
		const { serial, stalls } = chain();
		const hung = serial.run(NEVER, "install");
		const next = serial.run(async () => "went on");
		const outcome = hung.then(
			() => null,
			error => error,
		);
		await vi.advanceTimersByTimeAsync(1000);
		const error = await outcome;
		expect(error).toBeInstanceOf(StepStalledError);
		expect((error as StepStalledError).message).toContain("install did not finish in 1 s");
		expect(await next).toBe("went on");
		expect(stalls).toHaveLength(1);
		expect(stalls[0]).toMatchObject({ chain: "test", step: "install", ms: 1000 });
	});

	it("counts the bound from when a step starts, not from when it was queued", async () => {
		const { serial, stalls } = chain();
		const first = serial.run(() => elapse(800));
		const second = serial.run(async () => {
			await elapse(800);
			return "ok";
		});
		await vi.advanceTimersByTimeAsync(1600);
		await first;
		expect(await second).toBe("ok");
		expect(stalls).toEqual([]);
	});

	it("aborts the signal of the step it stops and tells onStall before the next step starts", async () => {
		const seen: string[] = [];
		const { serial } = chain({ onStall: () => seen.push("onStall") });
		let signal: AbortSignal | undefined;
		const hung = serial
			.run(abort => {
				signal = abort;
				return NEVER();
			})
			.catch(() => undefined);
		const next = serial.run(async () => {
			seen.push("next");
		});
		await vi.advanceTimersByTimeAsync(1000);
		await hung;
		await next;
		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBeInstanceOf(StepStalledError);
		expect(seen).toEqual(["onStall", "next"]);
	});

	it("a step's own failure does not stop the chain and is not a stall", async () => {
		const { serial, stalls } = chain();
		const failing = serial.run(async () => {
			throw new Error("boom");
		});
		const next = serial.run(async () => "after");
		await expect(failing).rejects.toThrow("boom");
		expect(await next).toBe("after");
		expect(stalls).toEqual([]);
	});

	it("a late result of a stopped step changes nothing", async () => {
		const { serial } = chain();
		const late = Promise.withResolvers<string>();
		const outcome = serial
			.run(() => late.promise)
			.then(
				() => "resolved",
				() => "stalled",
			);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await outcome).toBe("stalled");
		late.resolve("late");
		expect(await serial.run(async () => "fresh")).toBe("fresh");
	});

	it("counts the steps queued or running", async () => {
		const { serial } = chain();
		expect(serial.pending).toBe(0);
		const one = serial.run(async () => 1);
		const two = serial.run(async () => 2);
		expect(serial.pending).toBe(2);
		await Promise.all([one, two]);
		await Promise.resolve();
		expect(serial.pending).toBe(0);
	});

	it("a step's own bound replaces the chain's", async () => {
		const { serial, stalls } = chain();
		const long = serial.run(() => elapse(5000), "long", 10_000);
		const stalled = serial.run(NEVER, "never", 200);
		const settled = expect(stalled).rejects.toBeInstanceOf(StepStalledError);
		await vi.advanceTimersByTimeAsync(5000);
		await long;
		await vi.advanceTimersByTimeAsync(200);
		await settled;
		expect(stalls.map(stall => [stall.step, stall.ms])).toEqual([["never", 200]]);
	});

	it("a stopped step that resumes finds itself stopped at every fence, and a live one never does", async () => {
		const { serial } = chain();
		const gate = Promise.withResolvers<void>();
		const seen: string[] = [];
		const stalled = serial
			.run(async () => {
				const fenced = fencedCall(async () => "called");
				seen.push(stepStalled() ? "stopped early" : "live");
				await gate.promise;
				seen.push(stepStalled() ? "stopped" : "live");
				for (const fence of [throwIfStepStalled, () => fenced()]) {
					try {
						await fence();
						seen.push("passed");
					} catch (error) {
						seen.push((error as Error).name);
					}
				}
			}, "late")
			.catch(() => undefined);
		const next = serial.run(async () => {
			seen.push(stepStalled() ? "next stopped" : "next live");
			throwIfStepStalled();
			return "ok";
		});
		await vi.advanceTimersByTimeAsync(1000);
		await stalled;
		expect(await next).toBe("ok");
		gate.resolve();
		await vi.advanceTimersByTimeAsync(10);
		expect(seen).toEqual(["live", "next live", "stopped", "StepStalledError", "StepStalledError"]);
		expect(stepStalled()).toBe(false);
		expect(() => throwIfStepStalled()).not.toThrow();
	});

	describe("nested across chains", () => {
		it("a nested step is stopped with the step that called it, and its fenced effects never run", async () => {
			const outer = chain().serial;
			const inner = new SerialChain({ name: "inner", maxStepMs: 60_000, log: () => undefined });
			const effects: string[] = [];
			const gate = Promise.withResolvers<void>();
			let innerSignal: AbortSignal | undefined;
			const outerRun = outer
				.run(async () => {
					await inner.run(async signal => {
						innerSignal = signal;
						await gate.promise;
						throwIfStepStalled();
						effects.push("inner effect");
					}, "nested");
				}, "outer")
				.catch(error => error);
			await vi.advanceTimersByTimeAsync(1000);
			expect(await outerRun).toBeInstanceOf(StepStalledError);
			expect(innerSignal?.aborted).toBe(true);
			gate.resolve();
			await vi.advanceTimersByTimeAsync(10);
			expect(effects).toEqual([]);
			expect(inner.pending).toBe(0);
		});

		it("a nested step still waiting behind another never starts once its caller was stopped, and the chain goes on", async () => {
			const outer = chain().serial;
			const inner = chain().serial;
			const started: string[] = [];
			const gate = Promise.withResolvers<void>();
			const blocker = inner.run(async () => {
				await gate.promise;
			}, "blocker");
			const outerRun = outer
				.run(async () => {
					await inner.run(() => void started.push("nested"), "nested");
				}, "outer")
				.catch(error => error);
			await vi.advanceTimersByTimeAsync(1000);
			expect(await outerRun).toBeInstanceOf(StepStalledError);
			gate.resolve();
			await blocker;
			expect(await inner.run(() => "after", "after")).toBe("after");
			expect(started).toEqual([]);
			expect(inner.pending).toBe(0);
		});

		it("work queued by a caller whose step is already stopped rejects with its reason and does not hold the chain", async () => {
			const outer = chain().serial;
			const inner = chain().serial;
			const gate = Promise.withResolvers<void>();
			const seen: string[] = [];
			const outerRun = outer
				.run(async () => {
					await gate.promise;
					await inner.run(() => void seen.push("ran"), "late").catch(error => seen.push(error.name));
					expect(inner.pending).toBe(0);
				}, "outer")
				.catch(() => undefined);
			await vi.advanceTimersByTimeAsync(1000);
			await outerRun;
			gate.resolve();
			await vi.advanceTimersByTimeAsync(10);
			expect(seen).toEqual(["StepStalledError"]);
			expect(await inner.run(() => "free", "next")).toBe("free");
		});

		it("releases the caller's abort listeners when nested steps end (no leak over thousands of steps)", async () => {
			const outer = chain().serial;
			const inner = chain().serial;
			await outer.run(async () => {
				const parent = currentStepSignal() as AbortSignal;
				for (let i = 0; i < 3000; i++) await inner.run(() => i, "n");
				expect(getEventListeners(parent, "abort").length).toBe(0);
			}, "outer");
		});
	});
});
