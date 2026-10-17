import { createECDH, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import https from "node:https";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebPushPayload, WebPushSubscriptionJson } from "../../shared/web-push";
import { isPushEndpoint, PUSH_PAYLOAD_MAX_BYTES, PushSender, type PushTransport, webPushTransport } from "./push";
import type { VapidKeys } from "./vapid-store";
import { VAPID_SUBJECT } from "./vapid-store";

const require = createRequire(import.meta.url);
const ece = require("http_ece") as {
	decrypt(body: Buffer, params: { version: string; privateKey: unknown; authSecret: Buffer }): Buffer;
};

const payload: WebPushPayload = { v: 1, kind: "completion", title: "Tab", body: "Done", tabId: "t1", tag: "tab:t1" };

function vapid(): VapidKeys {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	// Node drops the scalar's leading zero bytes (1 key in 256 is 31 bytes); web-push wants 32, as its own
	// `generateVAPIDKeys` pads them.
	const scalar = ecdh.getPrivateKey();
	return {
		publicKey: ecdh.getPublicKey().toString("base64url"),
		privateKey: Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString("base64url"),
		subject: VAPID_SUBJECT,
	};
}

/** What a browser holds for a subscription: its key pair and auth secret. */
function browser() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = randomBytes(16);
	const subscription: WebPushSubscriptionJson = {
		endpoint: "https://push.example.com/send/abc",
		keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
	};
	return { ecdh, auth, subscription };
}

const options = { ttl: 3600, urgency: "normal" } as const;

afterEach(() => vi.restoreAllMocks());

describe("PushSender", () => {
	function sender(statusCode: number | Error, log: string[] = []) {
		const calls: Parameters<PushTransport["send"]>[] = [];
		const transport: PushTransport = {
			send: async (...args) => {
				calls.push(args);
				if (statusCode instanceof Error) throw statusCode;
				return { statusCode };
			},
		};
		const keys = vapid();
		return { push: new PushSender({ vapid: () => keys, transport, log: message => log.push(message) }), calls, keys };
	}

	it("sends the payload as JSON with the TTL, the urgency and the VAPID keys", async () => {
		const { push, calls, keys } = sender(201);
		const { subscription } = browser();
		expect(await push.send(subscription, payload, { ttl: 21600, urgency: "high" })).toBe("sent");
		const [sentTo, body, sentOptions] = calls[0] ?? [];
		expect(sentTo).toEqual(subscription);
		expect(JSON.parse(body ?? "")).toEqual(payload);
		expect(sentOptions).toMatchObject({ ttl: 21600, urgency: "high", vapid: keys, timeoutMs: 10_000 });
		expect(push.publicKey).toBe(keys.publicKey);
	});

	it("says `gone` for 404 and 410 so the caller forgets the subscription, and logs nothing", async () => {
		for (const status of [404, 410]) {
			const log: string[] = [];
			const { push } = sender(status, log);
			expect(await push.send(browser().subscription, payload, options)).toBe("gone");
			expect(log).toEqual([]);
		}
	});

	it("logs any other refusal and makes one attempt only", async () => {
		for (const status of [400, 401, 413, 429, 500, 503]) {
			const log: string[] = [];
			const { push, calls } = sender(status, log);
			expect(await push.send(browser().subscription, payload, options)).toBe("failed");
			expect(calls).toHaveLength(1);
			expect(log).toEqual([`web push refused with status ${status}`]);
		}
	});

	it("logs a network failure instead of throwing", async () => {
		const log: string[] = [];
		const { push, calls } = sender(new Error("getaddrinfo ENOTFOUND push.example.com"), log);
		expect(await push.send(browser().subscription, payload, options)).toBe("failed");
		expect(calls).toHaveLength(1);
		expect(log).toEqual(["web push failed: getaddrinfo ENOTFOUND push.example.com"]);
	});

	it("does not send a payload a push service would refuse", async () => {
		const log: string[] = [];
		const { push, calls } = sender(201, log);
		const big = { ...payload, body: "가".repeat(Math.ceil(PUSH_PAYLOAD_MAX_BYTES / 3) + 1) };
		expect(await push.send(browser().subscription, big, options)).toBe("failed");
		expect(calls).toHaveLength(0);
		expect(log[0]).toMatch(/over the limit/);
	});
});

describe("webPushTransport (the real web-push library, against a stand-in for the HTTPS request)", () => {
	function pushService(statusCode: number) {
		const seen: { options: https.RequestOptions; body: Buffer } = { options: {}, body: Buffer.alloc(0) };
		vi.spyOn(https, "request").mockImplementation(((
			requestOptions: https.RequestOptions,
			callback: (res: unknown) => void,
		) => {
			const request = new EventEmitter() as EventEmitter & { write(chunk: Buffer): void; end(): void };
			const chunks: Buffer[] = [];
			seen.options = requestOptions;
			request.write = chunk => chunks.push(Buffer.from(chunk));
			request.end = () => {
				seen.body = Buffer.concat(chunks);
				const response = Object.assign(new PassThrough(), { statusCode, headers: {} });
				callback(response);
				response.end("");
			};
			return request;
		}) as never);
		return seen;
	}

	it("posts a VAPID-signed, aes128gcm-encrypted payload the subscriber can decrypt", async () => {
		const seen = pushService(201);
		const keys = vapid();
		const { ecdh, auth, subscription } = browser();
		const result = await webPushTransport.send(subscription, JSON.stringify(payload), {
			ttl: 3600,
			urgency: "high",
			vapid: keys,
			timeoutMs: 10_000,
		});
		expect(result).toEqual({ statusCode: 201 });
		expect(seen.options).toMatchObject({ hostname: "push.example.com", path: "/send/abc", method: "POST" });
		const headers = seen.options.headers as Record<string, string | number>;
		expect(Number(headers.TTL)).toBe(3600);
		expect(headers.Urgency).toBe("high");
		expect(headers["Content-Encoding"]).toBe("aes128gcm");
		expect(headers.Authorization).toMatch(new RegExp(`^vapid t=.+, k=${keys.publicKey}$`));
		const clear = ece.decrypt(seen.body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth });
		expect(JSON.parse(clear.toString("utf8"))).toEqual(payload);
	});

	it("returns a refusal's status instead of throwing", async () => {
		pushService(410);
		const { subscription } = browser();
		const result = await webPushTransport.send(subscription, JSON.stringify(payload), {
			ttl: 60,
			urgency: "normal",
			vapid: vapid(),
			timeoutMs: 10_000,
		});
		expect(result).toEqual({ statusCode: 410 });
	});
});

describe("isPushEndpoint", () => {
	it("accepts the push services' https addresses", () => {
		for (const endpoint of [
			"https://fcm.googleapis.com/fcm/send/abc",
			"https://updates.push.services.mozilla.com/wpush/v2/abc",
			"https://web.push.apple.com/QAbc",
			"https://wns2-par02p.notify.windows.com/w/?token=abc",
		]) {
			expect(isPushEndpoint(endpoint), endpoint).toBe(true);
		}
	});

	it("refuses anything the host could be aimed at inside its own network", () => {
		for (const endpoint of [
			"http://fcm.googleapis.com/fcm/send/abc",
			"https://127.0.0.1/x",
			"https://192.168.1.1/x",
			"https://100.64.0.1/x",
			"https://[fd7a:115c:a1e0::1]/x",
			"https://localhost/x",
			"https://nas.local/x",
			"https://box.lan/x",
			"https://mac.tail-scale.ts.net/x",
			"https://fcm.googleapis.com:4443/x",
			"https://a:b@fcm.googleapis.com/x",
			"",
		]) {
			expect(isPushEndpoint(endpoint), endpoint).toBe(false);
		}
	});
});
