import { createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebPushPayload, WebPushSubscriptionJson } from "../../shared/web-push";
import { CoreError } from "../core/process";
import { coreTransport, PUSH_PAYLOAD_MAX_BYTES, type PushOptions, PushSender, type PushTransport } from "./push";
import { loadVapid } from "./vapid-store";

const require = createRequire(import.meta.url);
const ece = require("http_ece") as {
	decrypt(body: Buffer, params: { version: string; privateKey: unknown; authSecret: Buffer }): Buffer;
};

const payload: WebPushPayload = { v: 1, kind: "completion", title: "Tab", body: "Done", tabId: "t1", tag: "tab:t1" };

/** What a browser holds for a subscription: its key pair and auth secret. */
function browser(endpoint = "https://push.example.com/send/abc") {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = randomBytes(16);
	const subscription: WebPushSubscriptionJson = {
		endpoint,
		keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
	};
	return { ecdh, auth, subscription };
}

const options = { ttl: 3600, urgency: "normal" } as const;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "push-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
		return { push: new PushSender({ userData: dir, transport, log: message => log.push(message) }), calls };
	}

	it("sends the payload as JSON with the TTL and the urgency, and tells the public key the core signs with", async () => {
		const { push, calls } = sender(201);
		const { created } = await push.open();
		expect(created).toBe(true);
		expect((await loadVapid(dir)).publicKey).toBe(push.publicKey);
		const { subscription } = browser();
		expect(await push.send(subscription, payload, { ttl: 21600, urgency: "high" })).toBe("sent");
		const [sentTo, body, sentOptions] = calls[0] ?? [];
		expect(sentTo).toEqual(subscription);
		expect(JSON.parse(body ?? "")).toEqual(payload);
		expect(sentOptions).toEqual({ ttl: 21600, urgency: "high", timeoutMs: 10_000 });
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

describe("coreTransport (the real core, against a push service of its own on loopback)", () => {
	const services: http.Server[] = [];
	afterEach(() => {
		for (const server of services.splice(0)) server.close();
	});

	/** A push service on 127.0.0.1 that keeps the one request it gets and answers `statusCode`. */
	async function pushService(statusCode: number) {
		const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Buffer } = {
			headers: {},
			body: Buffer.alloc(0),
		};
		const server = http.createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				Object.assign(seen, { method: request.method, url: request.url, headers: request.headers });
				seen.body = Buffer.concat(chunks);
				response.writeHead(statusCode).end();
			});
		});
		services.push(server);
		await new Promise<void>(listening => server.listen(0, "127.0.0.1", listening));
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		return { seen, origin, endpoint: `${origin}/send/abc` };
	}

	const send = (subscription: WebPushSubscriptionJson, ttl = 3600, urgency: PushOptions["urgency"] = "high") =>
		coreTransport(dir).send(subscription, JSON.stringify(payload), { ttl, urgency, timeoutMs: 10_000 });

	it("posts a VAPID-signed, aes128gcm-encrypted payload the subscriber can decrypt", async () => {
		const { seen, origin, endpoint } = await pushService(201);
		const { publicKey, subject } = await loadVapid(dir);
		const { ecdh, auth, subscription } = browser(endpoint);
		const result = await send(subscription);
		expect(result).toEqual({ statusCode: 201 });
		expect(seen).toMatchObject({ method: "POST", url: "/send/abc" });
		const headers = seen.headers;
		expect(Number(headers.ttl)).toBe(3600);
		expect(headers.urgency).toBe("high");
		expect(headers["content-encoding"]).toBe("aes128gcm");
		expect(headers["content-type"]).toBe("application/octet-stream");
		const [, token, key] = /^vapid t=(.+), k=(.+)$/.exec(headers.authorization ?? "") ?? [];
		expect(key).toBe(publicKey);
		// The token is the ES256 JWT of RFC 8292: signed by the key `publicKey` names, for this push service.
		const [head, claims, signature] = (token ?? "").split(".");
		expect(JSON.parse(Buffer.from(head ?? "", "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
		const point = Buffer.from(publicKey, "base64url");
		const verifyingKey = createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: point.subarray(1, 33).toString("base64url"),
				y: point.subarray(33).toString("base64url"),
			},
			format: "jwk",
		});
		expect(
			verify(
				"sha256",
				Buffer.from(`${head}.${claims}`),
				{ key: verifyingKey, dsaEncoding: "ieee-p1363" },
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(true);
		const { aud, exp, sub } = JSON.parse(Buffer.from(claims ?? "", "base64url").toString()) as {
			aud: string;
			exp: number;
			sub: string;
		};
		expect({ aud, sub }).toEqual({ aud: origin, sub: subject });
		expect(exp).toBeGreaterThan(Date.now() / 1000 + 11 * 3600);
		expect(exp).toBeLessThan(Date.now() / 1000 + 13 * 3600);
		const clear = ece.decrypt(seen.body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth });
		expect(JSON.parse(clear.toString("utf8"))).toEqual(payload);
	});

	it("returns a refusal's status instead of throwing", async () => {
		const { endpoint } = await pushService(410);
		await loadVapid(dir);
		expect(await send(browser(endpoint).subscription, 60, "normal")).toEqual({ statusCode: 410 });
	});

	it("rejects with the core's fault when no push service answers, naming no endpoint", async () => {
		const { endpoint } = await pushService(201);
		await loadVapid(dir);
		await Promise.all(services.splice(0).map(server => new Promise(closed => server.close(closed))));
		const failure = await send(browser(`${endpoint}/secret-token`).subscription).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(CoreError);
		expect((failure as CoreError).code).toBe("push_connect");
		expect((failure as CoreError).message).not.toMatch(/secret-token|127\.0\.0\.1/);
	});

	it("will not send before the keypair was loaded", async () => {
		const { endpoint } = await pushService(201);
		const failure = await send(browser(endpoint).subscription).catch((error: unknown) => error);
		expect((failure as CoreError).code).toBe("no_vapid");
	});

	it("refuses an address that is not a push service's https address", async () => {
		await loadVapid(dir);
		for (const endpoint of [
			"http://push.example.com/x",
			"http://192.168.1.4/x",
			"https://user:pw@push.example.com/x",
		]) {
			const failure = await send(browser(endpoint).subscription).catch((error: unknown) => error);
			expect((failure as CoreError).code, endpoint).toBe("push_request");
		}
	});
});
