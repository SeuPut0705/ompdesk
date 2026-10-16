/**
 * The web server's limits, each a small clock-injected class so a test steps time instead of sleeping:
 * a token bucket (a socket's message rate), a sliding-window counter per key (pairing and session requests),
 * a per-key concurrency cap (heavy calls), and an exponential back-off for repeated failures.
 */

type Now = () => number;

/** Refills `ratePerSecond` tokens a second up to `burst`; `take` spends tokens or says no. */
export class TokenBucket {
	readonly #rate: number;
	readonly #burst: number;
	readonly #now: Now;
	#tokens: number;
	#at: number;

	constructor(ratePerSecond: number, burst: number, now: Now = Date.now) {
		this.#rate = ratePerSecond;
		this.#burst = burst;
		this.#now = now;
		this.#tokens = burst;
		this.#at = now();
	}

	take(count = 1): boolean {
		const now = this.#now();
		this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#rate);
		this.#at = now;
		if (this.#tokens < count) return false;
		this.#tokens -= count;
		return true;
	}
}

/** At most `max` hits per `windowMs` for each key. */
export class SlidingWindowLimiter {
	readonly #max: number;
	readonly #windowMs: number;
	readonly #now: Now;
	readonly #hits = new Map<string, number[]>();

	constructor(max: number, windowMs: number, now: Now = Date.now) {
		this.#max = max;
		this.#windowMs = windowMs;
		this.#now = now;
	}

	/** Count one hit of `key`; false (and nothing counted) when the window is full. */
	hit(key: string): boolean {
		const now = this.#now();
		const recent = this.#recent(key, now);
		if (recent.length >= this.#max) return false;
		recent.push(now);
		this.#hits.set(key, recent);
		this.#sweep(now);
		return true;
	}

	/** Milliseconds until `key` may hit again (0 when it may now). */
	retryAfterMs(key: string): number {
		const now = this.#now();
		const recent = this.#recent(key, now);
		const oldest = recent[0];
		return recent.length < this.#max || oldest === undefined ? 0 : oldest + this.#windowMs - now;
	}

	#recent(key: string, now: number): number[] {
		return (this.#hits.get(key) ?? []).filter(at => now - at < this.#windowMs);
	}

	/** Drop keys whose hits all aged out, so a scan over many addresses cannot grow the map without bound. */
	#sweep(now: number): void {
		if (this.#hits.size < 1024) return;
		for (const [key, hits] of this.#hits) {
			if (hits.every(at => now - at >= this.#windowMs)) this.#hits.delete(key);
		}
	}
}

/** At most `max` holders of a key at once. */
export class ConcurrencyLimiter {
	readonly #max: number;
	readonly #held = new Map<string, number>();

	constructor(max: number) {
		this.#max = max;
	}

	/** A release function, or null when `key` already holds `max`. The release is idempotent. */
	acquire(key: string): (() => void) | null {
		const held = this.#held.get(key) ?? 0;
		if (held >= this.#max) return null;
		this.#held.set(key, held + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.#held.get(key) ?? 1) - 1;
			if (left <= 0) this.#held.delete(key);
			else this.#held.set(key, left);
		};
	}
}

/** After each failure of a key the next attempt waits twice as long (base, 2×base … capped); a success forgets it. */
export class FailureBackoff {
	readonly #baseMs: number;
	readonly #maxMs: number;
	readonly #now: Now;
	readonly #state = new Map<string, { failures: number; until: number }>();

	constructor(baseMs: number, maxMs: number, now: Now = Date.now) {
		this.#baseMs = baseMs;
		this.#maxMs = maxMs;
		this.#now = now;
	}

	retryAfterMs(key: string): number {
		const entry = this.#state.get(key);
		return entry ? Math.max(0, entry.until - this.#now()) : 0;
	}

	fail(key: string): void {
		const failures = (this.#state.get(key)?.failures ?? 0) + 1;
		const delay = Math.min(this.#maxMs, this.#baseMs * 2 ** (failures - 1));
		this.#state.set(key, { failures, until: this.#now() + delay });
		if (this.#state.size > 1024) this.#sweep();
	}

	succeed(key: string): void {
		this.#state.delete(key);
	}

	#sweep(): void {
		const now = this.#now();
		for (const [key, entry] of this.#state) {
			if (entry.until + this.#maxMs < now) this.#state.delete(key);
		}
	}
}

export type PairingDecision = { ok: true } | { ok: false; retryAfterMs: number };

/** `/api/pair`: 10 a minute per source address, 30 a minute overall, and a growing wait after wrong codes. */
export class PairingGuard {
	readonly #perAddress: SlidingWindowLimiter;
	readonly #overall: SlidingWindowLimiter;
	readonly #backoff: FailureBackoff;

	constructor(now: Now = Date.now) {
		this.#perAddress = new SlidingWindowLimiter(10, 60_000, now);
		this.#overall = new SlidingWindowLimiter(30, 60_000, now);
		this.#backoff = new FailureBackoff(1000, 5 * 60_000, now);
	}

	/** Count one attempt of `address`. */
	check(address: string): PairingDecision {
		const wait = this.#backoff.retryAfterMs(address);
		if (wait > 0) return { ok: false, retryAfterMs: wait };
		if (!this.#perAddress.hit(address)) return { ok: false, retryAfterMs: this.#perAddress.retryAfterMs(address) };
		if (!this.#overall.hit("*")) return { ok: false, retryAfterMs: this.#overall.retryAfterMs("*") };
		return { ok: true };
	}

	fail(address: string): void {
		this.#backoff.fail(address);
	}

	succeed(address: string): void {
		this.#backoff.succeed(address);
	}
}

/**
 * Failed device authentications from anything unpaired: `record` is true exactly once when `threshold` of
 * them land within `windowMs` (the desktop is told once), then false until `quietMs` has passed.
 */
export class UnpairedThrottle {
	readonly #now: Now;
	readonly #threshold: number;
	readonly #windowMs: number;
	readonly #quietMs: number;
	readonly #times: number[] = [];
	#mutedUntil = 0;

	constructor(now: Now = Date.now, threshold = 3, windowMs = 60_000, quietMs = 10 * 60_000) {
		this.#now = now;
		this.#threshold = threshold;
		this.#windowMs = windowMs;
		this.#quietMs = quietMs;
	}

	record(): boolean {
		const now = this.#now();
		this.#times.push(now);
		while (this.#times.length > 0 && now - (this.#times[0] ?? now) >= this.#windowMs) this.#times.shift();
		if (now < this.#mutedUntil || this.#times.length < this.#threshold) return false;
		this.#mutedUntil = now + this.#quietMs;
		this.#times.length = 0;
		return true;
	}
}
