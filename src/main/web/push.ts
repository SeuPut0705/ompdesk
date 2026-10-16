/**
 * One Web Push message to one subscription: the `web-push` library's VAPID signing and payload encryption
 * behind an injectable transport, so tests put a fake push service where the network would be. A single
 * attempt, no backoff: a 404/410 means the browser dropped the subscription (the caller forgets it), any other
 * failure is logged and the notice is lost (a push is a courtesy; the page shows the state when opened).
 */
import webpush from "web-push";
import type { WebPushPayload, WebPushSubscriptionJson } from "../../shared/web-push";
import type { VapidKeys } from "./vapid-store";

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
		options: PushOptions & { vapid: VapidKeys; timeoutMs: number },
	): Promise<{ statusCode: number }>;
}

/** The real transport: `web-push` over HTTPS. A non-2xx answer comes back as its status, not as an exception. */
export const webPushTransport: PushTransport = {
	async send(subscription, body, options) {
		try {
			const result = await webpush.sendNotification(subscription, body, {
				TTL: options.ttl,
				urgency: options.urgency,
				timeout: options.timeoutMs,
				contentEncoding: "aes128gcm",
				vapidDetails: {
					subject: options.vapid.subject,
					publicKey: options.vapid.publicKey,
					privateKey: options.vapid.privateKey,
				},
			});
			return { statusCode: result.statusCode };
		} catch (error) {
			if (error instanceof webpush.WebPushError) return { statusCode: error.statusCode };
			throw error;
		}
	},
};

export const PUSH_ENDPOINT_MAX_CHARS = 2048;

/**
 * Whether a page may hand the host this URL to POST to: a push service's `https` address (a DNS name on the
 * default port, no credentials). The host sends the request, so a paired page must not aim it at a loopback,
 * LAN or tailnet address, or at an IP literal.
 */
export function isPushEndpoint(raw: string): boolean {
	if (raw.length > PUSH_ENDPOINT_MAX_CHARS) return false;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return false;
	const host = url.hostname.toLowerCase();
	if (!host.includes(".") || host.startsWith("[") || /^[0-9.]+$/.test(host)) return false;
	return !/\.(local|localhost|internal|lan|home|ts\.net)\.?$/.test(host);
}

/** A push service accepts up to 4096 bytes after encryption (RFC 8291 spends 103 on its header and tag). */
export const PUSH_PAYLOAD_MAX_BYTES = 3800;
const SEND_TIMEOUT_MS = 10_000;

export type PushResult = "sent" | "gone" | "failed";

export interface PushSenderDeps {
	vapid: () => VapidKeys;
	transport?: PushTransport | undefined;
	log?: ((message: string) => void) | undefined;
}

export class PushSender {
	readonly #deps: PushSenderDeps;

	constructor(deps: PushSenderDeps) {
		this.#deps = deps;
	}

	/** The public key a page subscribes against. */
	get publicKey(): string {
		return this.#deps.vapid().publicKey;
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
			const { statusCode } = await (this.#deps.transport ?? webPushTransport).send(subscription, body, {
				...options,
				vapid: this.#deps.vapid(),
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
