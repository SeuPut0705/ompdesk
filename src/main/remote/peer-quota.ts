/**
 * Per-device model-use limits on the host (D65): how many model requests
 * (prompts, steers, follow-ups, compactions…) and how many tokens a paired
 * device may spend on this computer's models per day. Both are optional; no
 * limit is the default. Usage counts per local calendar day and is stored on
 * the peer (`remote-peers.json`), so a restart does not reset it.
 *
 * LocalHostServices `reserve`s a request before it forwards a model command
 * (which commands: quota-commands.ts) or starts a benchmark or a model setup
 * run, and `refund`s it when that fails, so the check and the count never
 * have an await between them: N parallel requests at limit - 1 let exactly one
 * through. Tokens come from each assistant `message_end`'s usage. A turn
 * already running when the limit is crossed finishes; the next request is
 * refused.
 */
import type { PeerLimits, PeerUsageView } from "../../shared/ipc-types";
import type { PeerInfo, PeerStore } from "./peers-store";

/** `YYYY-MM-DD` of `date` in this computer's time zone. */
export function localDay(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export type QuotaRefusal = "requests" | "tokens";

/** A request counted ahead of its work: give it back with `refund` when the work did not run. */
export type QuotaReservation = { ok: true; refund(): void } | { ok: false; refusal: QuotaRefusal };

export class PeerQuota {
	readonly #peers: Pick<PeerStore, "get" | "update">;
	readonly #now: () => Date;
	readonly #changed: (deviceId: string) => void;

	constructor(peers: Pick<PeerStore, "get" | "update">, changed: (deviceId: string) => void, now = () => new Date()) {
		this.#peers = peers;
		this.#changed = changed;
		this.#now = now;
	}

	/** Today's usage of a peer (zero once the stored day is over). */
	usage(peer: PeerInfo): PeerUsageView {
		const today = localDay(this.#now());
		return peer.usage?.day === today
			? { requests: peer.usage.requests, tokens: peer.usage.tokens }
			: { requests: 0, tokens: 0 };
	}

	/** Which limit stops this device's next `requests` model requests, or null. */
	refusal(deviceId: string, requests = 1): QuotaRefusal | null {
		const peer = this.#peers.get(deviceId);
		if (!peer?.limits) return null;
		const used = this.usage(peer);
		if (peer.limits.requestsPerDay !== undefined && used.requests + requests > peer.limits.requestsPerDay)
			return "requests";
		if (peer.limits.tokensPerDay !== undefined && used.tokens >= peer.limits.tokensPerDay) return "tokens";
		return null;
	}

	/**
	 * Refuse, or count `requests` now (synchronously, so concurrent callers see each other's
	 * reservation). A weighted reservation (a benchmark's models × runs) is refused whole when it
	 * would take the day's count past the limit, never let through to cross it.
	 */
	reserve(deviceId: string, requests = 1): QuotaReservation {
		const refusal = this.refusal(deviceId, requests);
		if (refusal) return { ok: false, refusal };
		const day = localDay(this.#now());
		this.record(deviceId, { requests });
		let refunded = false;
		return {
			ok: true,
			refund: () => {
				if (refunded) return;
				refunded = true;
				this.#unrecord(deviceId, day, requests);
			},
		};
	}

	/** Undo `requests` of `day`'s count; a refund after the day turned over leaves the new day alone. */
	#unrecord(deviceId: string, day: string, requests: number): void {
		const peer = this.#peers.get(deviceId);
		if (peer?.usage?.day !== day) return;
		this.#peers.update(deviceId, {
			usage: { day, requests: Math.max(0, peer.usage.requests - requests), tokens: peer.usage.tokens },
		});
		this.#changed(deviceId);
	}

	record(deviceId: string, spent: { requests?: number; tokens?: number }): void {
		const peer = this.#peers.get(deviceId);
		if (!peer) return;
		const used = this.usage(peer);
		this.#peers.update(deviceId, {
			usage: {
				day: localDay(this.#now()),
				requests: used.requests + (spent.requests ?? 0),
				tokens: used.tokens + (spent.tokens ?? 0),
			},
		});
		this.#changed(deviceId);
	}

	/** Replace a device's limits; an empty object removes them. */
	setLimits(deviceId: string, limits: PeerLimits): boolean {
		const next: PeerLimits = {
			...(limits.requestsPerDay !== undefined ? { requestsPerDay: limits.requestsPerDay } : {}),
			...(limits.tokensPerDay !== undefined ? { tokensPerDay: limits.tokensPerDay } : {}),
		};
		const updated = this.#peers.update(deviceId, {
			limits: next.requestsPerDay === undefined && next.tokensPerDay === undefined ? undefined : next,
		});
		return updated !== undefined;
	}
}
