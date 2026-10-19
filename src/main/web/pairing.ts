/**
 * The desktop's say over a new web device (Settings › Mobile web › "approve new devices on this computer", off by
 * default). A device that Tailscale vouches for is held by `PairingConfirmations` until the desktop approves (a
 * dialog in the desktop renderer) or 60 s pass; with the setting off it is never asked.
 */
import { randomUUID } from "node:crypto";
import type { WebPairingRequest, WebPairingResponse } from "../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS, type WebPermission } from "../../shared/web-protocol";
import { sanitizeGrants } from "./devices-store";

export const PAIRING_CONFIRM_TIMEOUT_MS = 60_000;

export interface PairingDetails {
	/** Another OMPdesk computer (src/main/remote/) rather than a browser; absent = a browser. */
	kind?: "computer";
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
