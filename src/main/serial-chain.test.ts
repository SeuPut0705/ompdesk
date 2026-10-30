import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SerialChain, StepStalledError } from "./serial-chain";

const NEVER = () => Promise.withResolvers<never>().promise;

/** A step that ends `ms` of fake time after it starts. */
function after(ms: number): Promise<void> {
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
		const first = serial.run(() => after(800));
		const second = serial.run(async () => {
			await after(800);
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
});
