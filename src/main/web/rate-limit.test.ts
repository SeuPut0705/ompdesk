import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter, TokenBucket } from "./rate-limit";

function clock(start = 0) {
	const state = { now: start };
	return { state, now: () => state.now };
}

describe("TokenBucket", () => {
	it("lets a burst through, then the sustained rate, refilling with time", () => {
		const { state, now } = clock();
		const bucket = new TokenBucket(200, 400, now);
		let taken = 0;
		while (bucket.take()) taken += 1;
		expect(taken).toBe(400);
		state.now += 100;
		let refilled = 0;
		while (bucket.take()) refilled += 1;
		expect(refilled).toBe(20);
		state.now += 60_000;
		let capped = 0;
		while (bucket.take()) capped += 1;
		expect(capped).toBe(400);
	});
});

describe("ConcurrencyLimiter", () => {
	it("caps the holders of a key and frees a slot once, whatever the release count", () => {
		const limiter = new ConcurrencyLimiter(2);
		const first = limiter.acquire("d");
		const second = limiter.acquire("d");
		expect(limiter.acquire("d")).toBeNull();
		expect(limiter.acquire("other")).not.toBeNull();
		first?.();
		first?.();
		expect(limiter.acquire("d")).not.toBeNull();
		expect(limiter.acquire("d")).toBeNull();
		second?.();
	});
});
