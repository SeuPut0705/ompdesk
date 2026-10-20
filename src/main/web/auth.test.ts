/**
 * The request checks (the serve secret prefix, Host, Origin, Sec-Fetch-Site, Tailscale identity, Funnel), the
 * identity headers' RFC 2047 decoding, the device cookie, the one-time tokens and a device's key proof.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import {
	checkRequest,
	clearedDeviceCookie,
	decodeMimeWords,
	deviceCookieValue,
	isLoopbackAddress,
	OneTimeTokens,
	originOf,
	parsePublicKeyJwk,
	type RequestPolicy,
	serializeDeviceCookie,
	stripServePrefix,
	tailscaleLogin,
	verifyDeviceProof,
} from "./auth";

const HOST = "mac.tail1234.ts.net";
const SECRET = "s3cr3tPrefixValue_0123456789abcdefghijklmnop";
const policy = (over: Partial<RequestPolicy> = {}): RequestPolicy => ({
	host: HOST,
	publicPort: 47831,
	secure: true,
	servePrefix: SECRET,
	allowedUsers: () => ["me@example.com"],
	...over,
});
const good: IncomingHttpHeaders = {
	host: `${HOST}:47831`,
	origin: `https://${HOST}:47831`,
	"sec-fetch-site": "same-origin",
	"tailscale-user-login": "me@example.com",
};

function check(headers: IncomingHttpHeaders, over: Partial<Parameters<typeof checkRequest>[0]> = {}) {
	return checkRequest({
		headers,
		method: "POST",
		kind: "api",
		url: `/${SECRET}/api/pair`,
		remoteAddress: "127.0.0.1",
		policy: policy(),
		...over,
	});
}

describe("RFC 2047 identity headers", () => {
	it("decodes Q and B encoded words, joined words and plain text", () => {
		expect(decodeMimeWords("me@example.com")).toBe("me@example.com");
		expect(decodeMimeWords("=?utf-8?q?J=C3=BCrgen?=")).toBe("Jürgen");
		expect(decodeMimeWords(`=?UTF-8?B?${Buffer.from("홍길동").toString("base64")}?=`)).toBe("홍길동");
		expect(decodeMimeWords("=?utf-8?q?a_b?= =?utf-8?q?=C3=A9?=")).toBe("a bé");
		expect(decodeMimeWords("=?iso-8859-1?q?Andr=E9?=")).toBe("André");
		expect(decodeMimeWords("=?koi8-r?q?x?=")).toBe("=?koi8-r?q?x?=");
	});

	it("reads the login from the header, decoded", () => {
		expect(tailscaleLogin({ "tailscale-user-login": "=?utf-8?q?j=C3=BCrgen=40example.com?=" })).toBe(
			"jürgen@example.com",
		);
		expect(tailscaleLogin({})).toBeNull();
		expect(tailscaleLogin({ "tailscale-user-login": "  " })).toBeNull();
	});
});

describe("stripServePrefix", () => {
	it("takes the secret first segment off and keeps the rest", () => {
		expect(stripServePrefix(`/${SECRET}`, SECRET)).toBe("/");
		expect(stripServePrefix(`/${SECRET}/`, SECRET)).toBe("/");
		expect(stripServePrefix(`/${SECRET}/ws?x=1`, SECRET)).toBe("/ws?x=1");
		expect(stripServePrefix(`/${SECRET}?x=1`, SECRET)).toBe("/?x=1");
		expect(stripServePrefix(`/${SECRET}/assets/a.js`, SECRET)).toBe("/assets/a.js");
	});

	it("answers null for anything that is not exactly the secret segment", () => {
		expect(stripServePrefix("/api/pair", SECRET)).toBeNull();
		expect(stripServePrefix("/", SECRET)).toBeNull();
		expect(stripServePrefix(`/${SECRET}x/ws`, SECRET)).toBeNull();
		expect(stripServePrefix(`/${SECRET.slice(0, -1)}/ws`, SECRET)).toBeNull();
		expect(stripServePrefix(`/${SECRET.slice(0, -1)}X/ws`, SECRET)).toBeNull();
		expect(stripServePrefix(`//${SECRET}/ws`, SECRET)).toBeNull();
		expect(stripServePrefix(`/x/${SECRET}/ws`, SECRET)).toBeNull();
		expect(stripServePrefix("*", SECRET)).toBeNull();
	});
});

describe("checkRequest", () => {
	it("accepts the published host and origin from an allowed Tailscale user, with the prefix taken off", () => {
		expect(check(good)).toEqual({ ok: true, login: "me@example.com", target: "/api/pair" });
		expect(originOf(policy())).toBe(`https://${HOST}:47831`);
		expect(originOf(policy({ publicPort: 443 }))).toBe(`https://${HOST}`);
	});

	it("compares an encoded login after decoding and ignores case", () => {
		const encoded = { ...good, "tailscale-user-login": "=?utf-8?q?ME=40Example.com?=" };
		expect(check(encoded)).toMatchObject({ ok: true });
	});

	it("answers 404 and believes no header when the request did not come through serve (a forged login)", () => {
		// A local process can write every header, but not the secret prefix serve's target carries.
		expect(check(good, { url: "/api/pair" })).toMatchObject({ ok: false, status: 404, why: "other", login: null });
		expect(check(good, { url: "/" })).toMatchObject({ ok: false, status: 404 });
		expect(check(good, { url: `/${SECRET.slice(0, -1)}X/api/pair` })).toMatchObject({ ok: false, status: 404 });
		expect(check(good, { url: `/other/${SECRET}/api/pair` })).toMatchObject({ ok: false, status: 404 });
		const forged = { ...good, "tailscale-user-name": "x", "x-forwarded-for": "100.64.0.9" };
		expect(check(forged, { url: "/ws", kind: "ws", method: "GET" })).toMatchObject({ ok: false, status: 404 });
	});

	it("serves nothing while serve is not published (no prefix configured)", () => {
		expect(check(good, { policy: policy({ servePrefix: null }) })).toMatchObject({ ok: false, status: 404 });
		expect(check(good, { policy: policy({ servePrefix: null }), url: "/api/pair" })).toMatchObject({
			ok: false,
			status: 404,
		});
	});

	it("asks a request under the secret about to be published to come back (503), and still gives anything else a bare 404", () => {
		const starting = policy({ servePrefix: null, pendingPrefix: SECRET });
		expect(check(good, { policy: starting })).toMatchObject({ ok: false, status: 503 });
		expect(check({}, { policy: starting, url: `/${SECRET}/assets/SettingsPage-x.js`, method: "GET" })).toMatchObject({
			ok: false,
			status: 503,
		});
		expect(check(good, { policy: starting, url: "/api/pair" })).toMatchObject({ ok: false, status: 404 });
		expect(check(good, { policy: starting, url: `/${SECRET.slice(0, -1)}X/api/pair` })).toMatchObject({
			ok: false,
			status: 404,
		});
		// Published: the pending secret no longer decides anything.
		expect(check(good, { policy: policy({ pendingPrefix: "other" }) })).toMatchObject({ ok: true });
	});

	it("refuses a Host other than the published one (DNS rebinding)", () => {
		expect(check({ ...good, host: "evil.example:47831" })).toMatchObject({ ok: false, status: 421 });
		expect(check({ ...good, host: HOST })).toMatchObject({ ok: false, status: 421 });
		expect(check({ ...good, host: undefined })).toMatchObject({ ok: false, status: 421 });
	});

	it("requires the exact Origin for a POST and a WebSocket, and lets a GET omit it", () => {
		expect(check({ ...good, origin: "https://evil.example" })).toMatchObject({ ok: false, status: 403 });
		expect(check({ ...good, origin: "null" })).toMatchObject({ ok: false, status: 403 });
		expect(check({ ...good, origin: undefined })).toMatchObject({ ok: false, status: 403 });
		expect(check({ ...good, origin: undefined }, { kind: "ws", method: "GET" })).toMatchObject({ ok: false });
		expect(check({ ...good, origin: undefined }, { method: "GET", kind: "page" })).toMatchObject({ ok: true });
		expect(check({ ...good, origin: `https://${HOST}:47831` }, { kind: "ws", method: "GET" })).toMatchObject({
			ok: true,
		});
	});

	it("allows only same-origin and none for Sec-Fetch-Site, except a cross-site page navigation", () => {
		expect(check({ ...good, "sec-fetch-site": "none" })).toMatchObject({ ok: true });
		expect(check({ ...good, "sec-fetch-site": "same-site" })).toMatchObject({ ok: false, status: 403 });
		expect(check({ ...good, "sec-fetch-site": "cross-site" })).toMatchObject({ ok: false, status: 403 });
		const navigation = { ...good, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", origin: undefined };
		expect(check(navigation, { method: "GET", kind: "page" })).toMatchObject({ ok: true });
		expect(check(navigation, { method: "GET", kind: "api" })).toMatchObject({ ok: false });
	});

	it("names why a Tailscale user is refused: no user, another user, nobody allowed", () => {
		expect(check({ ...good, "tailscale-user-login": undefined })).toMatchObject({
			ok: false,
			status: 403,
			why: "no tailscale user",
			login: null,
		});
		expect(check({ ...good, "tailscale-user-login": "other@example.com" })).toMatchObject({
			ok: false,
			status: 403,
			why: "user not allowed",
			login: "other@example.com",
		});
		expect(check(good, { policy: policy({ allowedUsers: () => [] }) })).toMatchObject({
			ok: false,
			why: "user not allowed",
		});
	});

	it("refuses anything carrying the Funnel header, whatever else it has", () => {
		expect(check({ ...good, "tailscale-funnel-request": "?1" })).toMatchObject({
			ok: false,
			status: 403,
			reason: "funnel request",
		});
		// Funnel traffic carries no identity headers, and a public request never carries the prefix either.
		const funnel = { host: `${HOST}:47831`, "tailscale-funnel-request": "?1" };
		expect(check(funnel, { url: "/" })).toMatchObject({ ok: false, status: 403 });
	});

	it("serves only a loopback peer", () => {
		expect(check(good, { remoteAddress: "100.64.0.2" })).toMatchObject({ ok: false, status: 403 });
		expect(check(good, { remoteAddress: undefined })).toMatchObject({ ok: false });
		for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(address)).toBe(true);
		expect(isLoopbackAddress("10.0.0.1")).toBe(false);
	});
});

describe("device cookie", () => {
	it("is __Host- prefixed, HttpOnly and SameSite=Strict over HTTPS, and a plain name over HTTP", () => {
		const secure = serializeDeviceCookie("id.secret", true);
		expect(secure).toContain("__Host-ompdesk=id.secret");
		expect(secure).toContain("Path=/");
		expect(secure).toContain("HttpOnly");
		expect(secure).toContain("SameSite=Strict");
		expect(secure).toContain("Secure");
		expect(secure).not.toContain("Domain");
		const plain = serializeDeviceCookie("id.secret", false);
		expect(plain.startsWith("ompdesk=id.secret")).toBe(true);
		expect(plain).not.toContain("Secure");
		expect(clearedDeviceCookie(true)).toContain("Max-Age=0");
	});

	it("reads its own value out of a Cookie header and nothing else", () => {
		expect(deviceCookieValue({ cookie: "a=1; __Host-ompdesk=id.secret; b=2" }, true)).toBe("id.secret");
		expect(deviceCookieValue({ cookie: "ompdesk=id.secret" }, true)).toBeNull();
		expect(deviceCookieValue({ cookie: "ompdesk=x" }, false)).toBe("x");
		expect(deviceCookieValue({ cookie: "__Host-ompdesk=" }, true)).toBeNull();
		expect(deviceCookieValue({}, true)).toBeNull();
	});
});

describe("OneTimeTokens", () => {
	it("redeems once, within the time to live", () => {
		let now = 1000;
		const tokens = new OneTimeTokens<string>(30_000, () => now);
		const { token, expiresAt } = tokens.issue("device-a");
		expect(expiresAt).toBe(31_000);
		expect(tokens.redeem(token)).toBe("device-a");
		expect(tokens.redeem(token)).toBeNull();
		const late = tokens.issue("device-b").token;
		now += 30_000;
		expect(tokens.redeem(late)).toBeNull();
		expect(tokens.redeem("never-issued")).toBeNull();
	});
});

describe("a device's key proof", () => {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = parsePublicKeyJwk(publicKey.export({ format: "jwk" }));

	it("accepts an ECDSA P-256 public key and nothing with a private part or another curve", () => {
		expect(jwk).toMatchObject({ kty: "EC", crv: "P-256" });
		expect(parsePublicKeyJwk(privateKey.export({ format: "jwk" }))).toBeNull();
		expect(parsePublicKeyJwk({ ...publicKey.export({ format: "jwk" }), crv: "P-384" })).toBeNull();
		expect(parsePublicKeyJwk({ kty: "EC", crv: "P-256", x: "short", y: "short" })).toBeNull();
		expect(parsePublicKeyJwk("key")).toBeNull();
	});

	it("verifies the IEEE P1363 signature WebCrypto writes, and only for that nonce", () => {
		if (!jwk) throw new Error("no key");
		const signature = sign("sha256", Buffer.from("nonce-1"), { key: privateKey, dsaEncoding: "ieee-p1363" });
		expect(verifyDeviceProof(jwk, "nonce-1", signature.toString("base64url"))).toBe(true);
		expect(verifyDeviceProof(jwk, "nonce-2", signature.toString("base64url"))).toBe(false);
		expect(verifyDeviceProof(jwk, "nonce-1", "AAAA")).toBe(false);
		const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const forged = sign("sha256", Buffer.from("nonce-1"), { key: other.privateKey, dsaEncoding: "ieee-p1363" });
		expect(verifyDeviceProof(jwk, "nonce-1", forged.toString("base64url"))).toBe(false);
	});
});
