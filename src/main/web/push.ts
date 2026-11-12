/**
 * One Web Push message to one subscription: the core signs it with the host's VAPID key, encrypts it for the
 * subscription (RFC 8291) and POSTs it (`crates/core/src/web/push.rs`), behind an injectable transport so tests put a
 * fake push service where the network would be. A single attempt, no backoff: a 404/410 means the browser dropped
 * the subscription (the caller forgets it), any other failure is logged and the notice is lost (a push is a courtesy;
 * the page shows the state when opened).
 */
import type { WebPushPayload, WebPushSubscriptionJson } from "../../shared/web-push";
import { core } from "../core/process";
import { loadVapid } from "./vapid-store";

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export interface PushOptions {
	/** Seconds the push service keeps the message for an offline device. */
	ttl: number;
	urgency: PushUrgency;
}

/** The wire: delivers `body` (UTF-8 JSON) to the push service behind `subscription`, encrypted and VAPID signed. */
export interface PushTransport {
	send(
		subscription: WebPushSubscriptionJson,
		body: string,
		options: PushOptions & { timeoutMs: number },
	): Promise<{ statusCode: number }>;
}

/** The core waits `timeoutMs` for the push service; this side waits a little longer for the core's answer. */
const CORE_SLACK_MS = 5_000;

/**
 * The real transport: the core over HTTPS. A non-2xx answer comes back as its status, not as an exception; a request
 * that got no answer (no connection, TLS, timeout) rejects with the core's coded fault.
 */
export function coreTransport(userData: string): PushTransport {
	return {
		async send(subscription, body, options) {
			const answer = await core().call<{ statusCode: number }>(
				"push.send",
				{
					userData,
					subscription,
					payload: body,
					ttl: options.ttl,
					urgency: options.urgency,
					timeoutMs: options.timeoutMs,
				},
				{ timeoutMs: options.timeoutMs + CORE_SLACK_MS },
			);
			return answer.result;
		},
	};
}

/** A push service accepts up to 4096 bytes after encryption (RFC 8291 spends 103 on its header and tag). */
export const PUSH_PAYLOAD_MAX_BYTES = 3800;
const SEND_TIMEOUT_MS = 10_000;

export type PushResult = "sent" | "gone" | "failed";

export interface PushSenderDeps {
	/** The folder the core keeps the VAPID keypair in (`web-push.json`). */
	userData: string;
	transport?: PushTransport | undefined;
	log?: ((message: string) => void) | undefined;
}

export class PushSender {
	readonly #deps: PushSenderDeps;
	readonly #transport: PushTransport;
	#publicKey: string | null = null;

	constructor(deps: PushSenderDeps) {
		this.#deps = deps;
		this.#transport = deps.transport ?? coreTransport(deps.userData);
	}

	/**
	 * Loads the VAPID keypair in the core (making one when the file is unusable), before the first page asks for the
	 * public key or the first push goes out. `created` is true when every stored subscription was made against
	 * another key: the caller drops them.
	 */
	async open(): Promise<{ created: boolean }> {
		const { publicKey, created } = await loadVapid(this.#deps.userData);
		this.#publicKey = publicKey;
		return { created };
	}

	/** The public key a page subscribes against; only once `open` has answered. */
	get publicKey(): string {
		if (this.#publicKey === null) throw new Error("web push: the VAPID keypair is not loaded yet");
		return this.#publicKey;
	}

	/** Never throws: `gone` (404/410) tells the caller to forget the subscription. */
	async send(
		subscription: WebPushSubscriptionJson,
		payload: WebPushPayload,
		options: PushOptions,
	): Promise<PushResult> {
		const body = JSON.stringify(payload);
		if (Buffer.byteLength(body) > PUSH_PAYLOAD_MAX_BYTES) {
			this.#deps.log?.(`web push not sent: payload of ${Buffer.byteLength(body)} bytes is over the limit`);
			return "failed";
		}
		try {
			const { statusCode } = await this.#transport.send(subscription, body, {
				...options,
				timeoutMs: SEND_TIMEOUT_MS,
			});
			if (statusCode >= 200 && statusCode < 300) return "sent";
			if (statusCode === 404 || statusCode === 410) return "gone";
			this.#deps.log?.(`web push refused with status ${statusCode}`);
			return "failed";
		} catch (error) {
			this.#deps.log?.(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
			return "failed";
		}
	}
}
