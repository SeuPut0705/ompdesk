/**
 * The page socket's limits (`ws-router.ts`), each a small clock-injected class so a test steps time instead of
 * sleeping: a token bucket (a socket's message rate) and a per-key concurrency cap (heavy calls). The edge's limits
 * (pairing, session and push requests, unpaired authentications) are the core's (`crates/core/src/web/limits.rs`).
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
