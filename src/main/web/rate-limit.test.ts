import { describe, expect, it } from "vitest";
import {
	ConcurrencyLimiter,
	FailureBackoff,
	PairingGuard,
	SlidingWindowLimiter,
	TokenBucket,
	UnpairedThrottle,
} from "./rate-limit";

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

describe("SlidingWindowLimiter", () => {
	it("allows max hits per window per key, and tells when the next is free", () => {
		const { state, now } = clock();
		const limiter = new SlidingWindowLimiter(3, 60_000, now);
		expect([1, 2, 3].map(() => limiter.hit("a"))).toEqual([true, true, true]);
		expect(limiter.hit("a")).toBe(false);
		expect(limiter.hit("b")).toBe(true);
		expect(limiter.retryAfterMs("a")).toBe(60_000);
		state.now += 59_999;
		expect(limiter.hit("a")).toBe(false);
		state.now += 1;
		expect(limiter.hit("a")).toBe(true);
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

describe("FailureBackoff", () => {
	it("doubles the wait after each failure up to a cap and forgets on success", () => {
		const { state, now } = clock();
		const backoff = new FailureBackoff(1000, 5000, now);
		expect(backoff.retryAfterMs("ip")).toBe(0);
		backoff.fail("ip");
		expect(backoff.retryAfterMs("ip")).toBe(1000);
		state.now += 1000;
		backoff.fail("ip");
		expect(backoff.retryAfterMs("ip")).toBe(2000);
		state.now += 2000;
		backoff.fail("ip");
		backoff.fail("ip");
		backoff.fail("ip");
		expect(backoff.retryAfterMs("ip")).toBe(5000);
		backoff.succeed("ip");
		expect(backoff.retryAfterMs("ip")).toBe(0);
	});
});

describe("PairingGuard", () => {
	it("allows 10 a minute per address and 30 overall, and backs off after a wrong code", () => {
		const { state, now } = clock();
		const guard = new PairingGuard(now);
		for (let i = 0; i < 10; i++) expect(guard.check("1.1.1.1").ok).toBe(true);
		expect(guard.check("1.1.1.1")).toMatchObject({ ok: false });
		for (let i = 0; i < 10; i++) expect(guard.check("2.2.2.2").ok).toBe(true);
		for (let i = 0; i < 10; i++) expect(guard.check("3.3.3.3").ok).toBe(true);
		expect(guard.check("4.4.4.4")).toMatchObject({ ok: false });
		state.now += 60_000;
		expect(guard.check("4.4.4.4").ok).toBe(true);
		guard.fail("4.4.4.4");
		expect(guard.check("4.4.4.4")).toEqual({ ok: false, retryAfterMs: 1000 });
		state.now += 1000;
		expect(guard.check("4.4.4.4").ok).toBe(true);
	});
});

describe("UnpairedThrottle", () => {
	it("fires once at three failures in a minute, then stays quiet for a while", () => {
		const { state, now } = clock();
		const throttle = new UnpairedThrottle(now);
		expect([throttle.record(), throttle.record()]).toEqual([false, false]);
		state.now += 61_000;
		expect(throttle.record()).toBe(false);
		expect([throttle.record(), throttle.record()]).toEqual([false, true]);
		expect([throttle.record(), throttle.record(), throttle.record()]).toEqual([false, false, false]);
		state.now += 10 * 60_000;
		expect([throttle.record(), throttle.record(), throttle.record()]).toEqual([false, false, true]);
	});
});
