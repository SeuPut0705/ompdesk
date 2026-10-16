/**
 * Pairing a web device. `WebPairing` is its own instance of the remote devices' code (remote/crypto.ts: eight
 * Crockford characters), kept apart from `RemoteHost`'s: a code lives 10 minutes, works once, a new one
 * replaces the unused one, and five wrong tries replace it too. A phone that enters it is then held by
 * `PairingConfirmations` until the desktop approves (a dialog in the desktop renderer) or 60 s pass.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WebPairingCode, WebPairingRequest, WebPairingResponse } from "../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS, type WebPermission } from "../../shared/web-protocol";
import { formatCode, generateCode, normalizeCode } from "../remote/crypto";
import { sanitizeGrants } from "./devices-store";

export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Wrong codes allowed before the code is replaced. */
export const MAX_PAIRING_FAILURES = 5;
export const PAIRING_CONFIRM_TIMEOUT_MS = 60_000;

export type PairingAttempt =
	/** Right code; it is spent. */
	| "ok"
	| "wrong"
	/** The fifth wrong try: the code was replaced. */
	| "locked"
	/** No code is issued, or it ran out: the server answers 404 so the endpoint is no oracle. */
	| "inactive";

export class WebPairing {
	readonly #now: () => number;
	readonly #onChange: () => void;
	#code: { value: string; expiresAt: number } | null = null;
	#failures = 0;

	constructor(now: () => number = Date.now, onChange: () => void = () => {}) {
		this.#now = now;
		this.#onChange = onChange;
	}

	/** A fresh code; an unused one stops working. */
	issue(): WebPairingCode {
		const value = generateCode();
		const expiresAt = this.#now() + PAIRING_CODE_TTL_MS;
		this.#code = { value, expiresAt };
		this.#failures = 0;
		this.#onChange();
		return { code: formatCode(value), expiresAt };
	}

	/** The code a phone may enter now, or null. */
	active(): WebPairingCode | null {
		const code = this.#live();
		return code ? { code: formatCode(code.value), expiresAt: code.expiresAt } : null;
	}

	attempt(input: string): PairingAttempt {
		const code = this.#live();
		if (!code) return "inactive";
		const typed = normalizeCode(input);
		if (typed !== null && timingSafeEqual(Buffer.from(typed), Buffer.from(code.value))) {
			this.#code = null;
			this.#failures = 0;
			this.#onChange();
			return "ok";
		}
		this.#failures += 1;
		if (this.#failures < MAX_PAIRING_FAILURES) return "wrong";
		this.issue();
		return "locked";
	}

	/** Stop accepting the code (the feature is turned off). */
	clear(): void {
		if (!this.#code) return;
		this.#code = null;
		this.#failures = 0;
		this.#onChange();
	}

	#live(): { value: string; expiresAt: number } | null {
		if (this.#code && this.#now() >= this.#code.expiresAt) {
			this.#code = null;
			this.#failures = 0;
		}
		return this.#code;
	}
}

export interface PairingDetails {
	name: string;
	userAgent: string;
	tailscaleLogin: string | null;
	ip: string | null;
}

export type PairingOutcome =
	| { approved: true; grants: WebPermission[] }
	| { approved: false; reason: "declined" | "timeout" };

interface Pending {
	request: WebPairingRequest;
	settle: (outcome: PairingOutcome) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** The phones waiting for the desktop's answer: each is shown once to the desktop windows and settles once. */
export class PairingConfirmations {
	readonly #notify: (request: WebPairingRequest) => void;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, Pending>();

	constructor(opts: { notify: (request: WebPairingRequest) => void; now?: () => number; timeoutMs?: number }) {
		this.#notify = opts.notify;
		this.#now = opts.now ?? Date.now;
		this.#timeoutMs = opts.timeoutMs ?? PAIRING_CONFIRM_TIMEOUT_MS;
	}

	/** Ask the desktop; settles with the answer, or `timeout` after 60 s. */
	request(details: PairingDetails): Promise<PairingOutcome> {
		const request: WebPairingRequest = {
			id: randomUUID(),
			...details,
			grants: [...DEFAULT_WEB_GRANTS],
			expiresAt: this.#now() + this.#timeoutMs,
		};
		return new Promise<PairingOutcome>(resolve => {
			const settle = (outcome: PairingOutcome): void => {
				const entry = this.#pending.get(request.id);
				if (!entry) return;
				clearTimeout(entry.timer);
				this.#pending.delete(request.id);
				resolve(outcome);
			};
			const timer = setTimeout(() => settle({ approved: false, reason: "timeout" }), this.#timeoutMs);
			this.#pending.set(request.id, { request, settle, timer });
			this.#notify(request);
		});
	}

	/** The desktop's answer; false for an id that already settled or never existed. */
	respond(response: WebPairingResponse): boolean {
		const entry = this.#pending.get(response.id);
		if (!entry) return false;
		entry.settle(
			response.approve
				? { approved: true, grants: sanitizeGrants(response.grants ?? entry.request.grants) }
				: { approved: false, reason: "declined" },
		);
		return true;
	}

	/** Requests a desktop window that just opened should show. */
	pending(): WebPairingRequest[] {
		return [...this.#pending.values()].map(entry => entry.request);
	}

	/** Decline everything still waiting (the server stops). */
	declineAll(): void {
		for (const entry of [...this.#pending.values()]) entry.settle({ approved: false, reason: "declined" });
	}
}
