/**
 * The whole web server on an ephemeral loopback port, behind the secret path prefix `tailscale serve`'s target
 * carries and with the identity headers it adds: static allowlist, request checks, a device connecting on its first
 * visit (and with the desktop's approval when that is on), which account may open the page, forged headers without
 * the prefix, blocking and unblocking a device, the key-proof session ticket, a WebSocket that invokes a
 * passthrough channel against a fake handler, uploads and blobs, and revocation closing the socket. Only Electron
 * is faked (the IPC registry, the desktop window and `tailscale whois`); the server, router, stores and `ws` are
 * the real ones.
 */
import { createECDH, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import {
	WEB_BLOCKS_LIST,
	WEB_BLOCKS_REMOVE,
	WEB_DEVICE_CONNECTED,
	WEB_DEVICES_LIST,
	WEB_DEVICES_REVOKE,
	WEB_PAIRING_REQUEST,
	type WebBlockedInfo,
	type WebDeviceInfo,
	type WebPairingRequest,
} from "../../shared/mobile-web";
import { WEB_HOST_CHANNELS, type WebBlobOpenResult } from "../../shared/web-host";
import type { WebServerFrame } from "../../shared/web-protocol";
import type { WebPushStateResponse } from "../../shared/web-push";
import type { TailnetPeer } from "../tailscale/whois";
import { itWithFileSymlinks } from "../test-symlinks";
import type { ClientWindow } from "./client-window";
import type { IpcCaller } from "./ipc-registry";
import { WebHost, type WebHostDeps } from "./web-host";

type Handler = (caller: IpcCaller, ...args: unknown[]) => unknown;

let userData: string;
let staticRoot: string;
let host: WebHost;
let base: string;
let port: number;
let handlers: Map<string, Handler>;
let desktopSent: { channel: string; payload: unknown }[];
let unpaired: ReturnType<typeof vi.fn>;
let confirmNew: boolean;
let approve: boolean;
let sockets: WebSocket[];
let peers: Map<string, TailnetPeer>;
let allowed: string[];
let realFetch: typeof fetch;

/** The secret first path segment of the serve target; a request carries it only when it came through serve. */
const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const LOGIN = "me@example.com";
/** The phone's tailnet address, as serve writes it into `X-Forwarded-For`. */
const PEER_IP = "100.64.0.9";
/** What serve adds to every request it forwards. */
const IDENTITY: Record<string, string> = { "tailscale-user-login": LOGIN, "x-forwarded-for": PEER_IP };

const PAGE = "<!doctype html><title>OMPdesk</title>";
const SCRIPT = `${"console.log('x');".repeat(200)}\n`;

function desktop(): ClientWindow {
	return {
		webContents: {
			id: 1,
			send: (channel: string, payload: unknown) => {
				desktopSent.push({ channel, payload });
				if (channel === WEB_PAIRING_REQUEST) {
					const request = payload as WebPairingRequest;
					queueMicrotask(() => host.confirmations.respond({ id: request.id, approve }));
				}
			},
		},
		isDestroyed: () => false,
		once: () => undefined,
		removeListener: () => undefined,
	};
}

beforeEach(async () => {
	userData = mkdtempSync(join(tmpdir(), "web-server-"));
	staticRoot = mkdtempSync(join(tmpdir(), "web-static-"));
	mkdirSync(join(staticRoot, "assets"));
	writeFileSync(join(staticRoot, "web.html"), PAGE);
	writeFileSync(join(staticRoot, "assets", "app-abc.js"), SCRIPT);
	writeFileSync(join(staticRoot, "secret.txt"), "private");
	handlers = new Map();
	desktopSent = [];
	unpaired = vi.fn();
	confirmNew = false;
	approve = true;
	sockets = [];
	allowed = [LOGIN];
	peers = new Map([[PEER_IP, { nodeId: "nPHONE1", nodeName: "s25u", login: LOGIN }]]);
	const deps: WebHostDeps = {
		ipc: {
			handle: <A extends unknown[]>(channel: string, handler: (caller: IpcCaller, ...args: A) => unknown): void => {
				handlers.set(channel, handler as Handler);
			},
			invoke: async (channel, caller, args) => {
				const handler = handlers.get(channel);
				if (!handler) throw new Error(`No handler registered for '${channel}'`);
				return handler(caller, ...args);
			},
			send: () => undefined,
		},
		userData,
		staticRoot: () => staticRoot,
		desktopWindows: () => [desktop()],
		tabs: { activeTab: () => null, cwd: () => null, facts: () => null, resnapshot: () => {} },
		openMedia: async () => new Response(null, { status: 404 }),
		shell: { openPath: async () => {}, reveal: () => {}, openExternal: async () => {} },
		allowedUsers: () => allowed,
		confirmNewDevices: () => confirmNew,
		whois: async address => peers.get(address) ?? null,
		onUnpairedAuth: unpaired,
		language: () => "en",
	};
	host = new WebHost(deps);
	({ port } = await host.start({ port: 0 }));
	// What the service tells the server once serve is published: this address and the secret path.
	host.server.configure({ host: "127.0.0.1", publicPort: port, secure: false, servePrefix: SECRET });
	base = `http://127.0.0.1:${port}/${SECRET}`;
	// Every request of the tests carries serve's identity headers unless a test overrides one.
	realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init: RequestInit = {}) =>
		realFetch(input, { ...init, headers: { ...IDENTITY, ...(init.headers as Record<string, string> | undefined) } }),
	);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await host.stop();
	rmSync(userData, { recursive: true, force: true });
	rmSync(staticRoot, { recursive: true, force: true });
});

const origin = () => `http://127.0.0.1:${port}`;

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: origin(), "user-agent": "TestBrowser/1.0", ...headers },
		body: JSON.stringify(body),
	});
}

/** A raw request at `target` exactly as written (the secret prefix is the caller's), with serve's headers. */
function rawAt(
	target: string,
	headers: Record<string, string> = {},
	method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{
		status: number;
		headers: http.IncomingHttpHeaders;
		body: string;
	}>();
	const req = http.request(
		{
			host: "127.0.0.1",
			port,
			path: target,
			method,
			headers: { host: `127.0.0.1:${port}`, ...IDENTITY, ...headers },
		},
		res => {
			const chunks: Buffer[] = [];
			res.on("data", chunk => chunks.push(chunk as Buffer));
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
			);
		},
	);
	req.on("error", reject);
	req.end();
	return promise;
}

/** A raw request through serve (the prefix added), for a path or Host that `fetch` would normalise. */
function raw(path: string, headers: Record<string, string> = {}, method = "GET") {
	return rawAt(`/${SECRET}${path}`, headers, method);
}

/** What the desktop was sent on `channel`. */
const sent = (channel: string): unknown[] =>
	desktopSent.filter(item => item.channel === channel).map(item => item.payload);

interface Paired {
	cookie: string;
	deviceId: string;
	privateKey: KeyObject | null;
}

async function pair(options: { withKey?: boolean; name?: string } = {}): Promise<Paired> {
	const keys = options.withKey === false ? null : generateKeyPairSync("ec", { namedCurve: "P-256" });
	const response = await post(
		"/api/pair",
		{
			name: options.name ?? "Test phone",
			clientInstanceId: "browser-1",
			...(keys ? { publicKeyJwk: keys.publicKey.export({ format: "jwk" }) } : {}),
		},
		{ "user-agent": "TestBrowser/1.0" },
	);
	expect(response.status).toBe(200);
	const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	const body = (await response.json()) as { deviceId: string };
	return { cookie, deviceId: body.deviceId, privateKey: keys?.privateKey ?? null };
}

async function ticketFor(paired: Paired, headers: Record<string, string> = {}): Promise<string> {
	const first = await post("/api/session", {}, { cookie: paired.cookie, ...headers });
	expect(first.status).toBe(200);
	const body = (await first.json()) as { ticket?: string; nonce?: string };
	if (body.ticket) return body.ticket;
	if (!body.nonce || !paired.privateKey) throw new Error("no nonce");
	const sig = sign("sha256", Buffer.from(body.nonce), { key: paired.privateKey, dsaEncoding: "ieee-p1363" });
	const second = await post(
		"/api/session",
		{ nonce: body.nonce, sig: sig.toString("base64url") },
		{ cookie: paired.cookie, ...headers },
	);
	expect(second.status).toBe(200);
	return ((await second.json()) as { ticket: string }).ticket;
}

function open(
	paired: Paired | null,
	ticket: string,
	headers: Record<string, string> = {},
): Promise<{ socket: WebSocket; frames: WebServerFrame[] }> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/${SECRET}/ws`, ["ompdesk.v1", `ticket.${ticket}`], {
			headers: {
				origin: origin(),
				"user-agent": "TestBrowser/1.0",
				...IDENTITY,
				...(paired ? { cookie: paired.cookie } : {}),
				...headers,
			},
		});
		sockets.push(socket);
		const frames: WebServerFrame[] = [];
		socket.on("message", data => frames.push(JSON.parse(data.toString()) as WebServerFrame));
		socket.once("open", () => resolve({ socket, frames }));
		socket.once("error", reject);
		socket.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
	});
}

const until = async (predicate: () => boolean): Promise<void> => {
	// Real sockets: yield to the event loop until what the test waits for has arrived.
	for (let i = 0; i < 20_000 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
	expect(predicate()).toBe(true);
};

describe("request checks", () => {
	it("answers /healthz and refuses a foreign Host, a POST without Origin and a foreign Origin", async () => {
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		expect((await raw("/healthz", { host: "evil.example" })).status).toBe(421);
		const noOrigin = await fetch(`${base}/api/session`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(noOrigin.status).toBe(403);
		expect((await post("/api/session", {}, { origin: "http://evil.example" })).status).toBe(403);
		expect((await raw("/healthz", { "sec-fetch-site": "cross-site" })).status).toBe(403);
		expect((await raw("/healthz", { "tailscale-funnel-request": "?1" })).status).toBe(403);
	});

	it("sends no CORS headers", async () => {
		const response = await fetch(`${base}/healthz`, { headers: { origin: origin() } });
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});
});

describe("static files", () => {
	it("serves web.html at / and /pair with the page CSP, and nothing outside the allowlist", async () => {
		for (const path of ["/", "/pair"]) {
			const page = await raw(path);
			expect(page.status).toBe(200);
			expect(page.body).toBe(PAGE);
			expect(page.headers["content-security-policy"]).toContain(`connect-src 'self' ws://127.0.0.1:${port}`);
			expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
			expect(page.headers["x-content-type-options"]).toBe("nosniff");
			expect(page.headers["cache-control"]).toBe("no-cache");
		}
		expect((await raw("/secret.txt")).status).toBe(404);
		expect((await raw("/web.html")).status).toBe(404);
		expect((await raw("/package.json")).status).toBe(404);
		expect((await raw("/assets/missing.js")).status).toBe(404);
	});

	it("serves pre-paint.js, which web.html loads before anything else", async () => {
		writeFileSync(join(staticRoot, "pre-paint.js"), "document.documentElement.dataset.ready = '1';");
		const script = await raw("/pre-paint.js");
		expect(script.status).toBe(200);
		expect(script.headers["content-type"]).toContain("text/javascript");
	});

	it("serves hashed assets as immutable, compresses with brotli on request, and answers HEAD", async () => {
		const plain = await raw("/assets/app-abc.js");
		expect(plain.status).toBe(200);
		expect(plain.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
		expect(plain.headers["content-type"]).toContain("text/javascript");
		const packed = await fetch(`${base}/assets/app-abc.js`, { headers: { "accept-encoding": "br" } });
		expect(packed.headers.get("content-encoding")).toBe("br");
		expect(await packed.text()).toBe(SCRIPT);
		const head = await raw("/assets/app-abc.js", {}, "HEAD");
		expect(head.status).toBe(200);
		expect(head.body).toBe("");
		expect((await raw("/", { origin: origin() }, "POST")).status).toBe(405);
	});

	it("refuses traversal, backslashes, NULs and encoded separators", async () => {
		for (const path of [
			"/assets/../secret.txt",
			"/assets/..%2fsecret.txt",
			"/assets/%2e%2e/secret.txt",
			"/assets/a\\b",
			"/assets/a%00b",
			"/assets//app-abc.js",
		]) {
			const result = await raw(path);
			expect([400, 404], path).toContain(result.status);
			expect(result.body, path).not.toContain("private");
		}
	});

	itWithFileSymlinks("does not follow a symlink out of the built folder", async () => {
		symlinkSync(join(staticRoot, "secret.txt"), join(staticRoot, "assets", "link.js"));
		const outside = mkdtempSync(join(tmpdir(), "web-outside-"));
		writeFileSync(join(outside, "x.js"), "outside");
		symlinkSync(join(outside, "x.js"), join(staticRoot, "assets", "out.js"));
		expect((await raw("/assets/out.js")).status).toBe(404);
		rmSync(outside, { recursive: true, force: true });
	});

	// v0.38.1: a phone's page, older than the computer's update, asked for a lazy chunk the new build no longer had.
	it("after an update, serves the previous build's hashed assets by name, and nothing else from them", async () => {
		// This launch kept its build (WebHost.start, queued first); the next one runs a new build without the old chunk.
		await host.assets.retain(staticRoot);
		expect(existsSync(join(userData, "web-assets", "builds.json"))).toBe(true);
		writeFileSync(join(staticRoot, "web.html"), `${PAGE}<!-- next build -->`);
		rmSync(join(staticRoot, "assets", "app-abc.js"));
		writeFileSync(join(staticRoot, "assets", "app-def.js"), "next");
		await host.assets.retain(staticRoot);
		const old = await raw("/assets/app-abc.js");
		expect(old.status).toBe(200);
		expect(old.body).toBe(SCRIPT);
		expect(old.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
		expect((await raw("/assets/app-def.js")).body).toBe("next");
		expect((await raw("/assets/missing.js")).status).toBe(404);
		expect((await raw("/assets/../web-assets/builds.json")).status).not.toBe(200);
	});

	// Windows CI (release run 39191568825): the teardown's rmSync of userData hit ENOTEMPTY because the start's copy
	// of the build into web-assets/ was still writing after stop() returned.
	it("stop() returns only once the start's background work in userData is done", async () => {
		await host.stop();
		expect(existsSync(join(userData, "web-assets", "builds.json"))).toBe(true);
	});
});

describe("connecting a device", () => {
	it("makes the device on the first visit of an allowed login: hardened cookie, named from whois, the desktop told once", async () => {
		const response = await post("/api/pair", { name: "Android phone · Chrome" }, { "user-agent": "Safari/1" });
		expect(response.status).toBe(200);
		const cookie = response.headers.get("set-cookie") ?? "";
		expect(cookie).toMatch(/^ompdesk=[\w-]+\.[\w-]{43};/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(await response.json()).toMatchObject({ name: "s25u", grants: expect.arrayContaining(["workspace"]) });
		const [device] = host.devices.list();
		expect(device).toMatchObject({ name: "s25u", userAgent: "Safari/1", tailscaleLogin: LOGIN, nodeId: "nPHONE1" });
		expect(device?.grants).not.toContain("pairing-admin");
		expect(sent(WEB_PAIRING_REQUEST)).toEqual([]);
		expect(sent(WEB_DEVICE_CONNECTED)).toEqual([{ id: device?.deviceId, name: "s25u", tailscaleLogin: LOGIN }]);
	});

	it("compares an encoded login after decoding", async () => {
		const encoded = "=?utf-8?q?ME=40Example.com?=";
		expect((await post("/api/pair", { name: "x" }, { "tailscale-user-login": encoded })).status).toBe(200);
	});

	it("names the device from the page when whois cannot say, and keeps it without a node identity", async () => {
		const response = await post("/api/pair", { name: "iPhone · Safari" }, { "x-forwarded-for": "100.64.0.77" });
		expect(response.status).toBe(200);
		expect(host.devices.list()[0]).toMatchObject({ name: "iPhone · Safari", nodeId: null });
		expect((await post("/api/pair", { name: "  " }, { "x-forwarded-for": "100.64.0.78" })).status).toBe(200);
		expect(host.devices.list().map(device => device.name)).toContain("Phone");
	});

	it("refuses a login that whois does not put behind the address", async () => {
		peers.set(PEER_IP, { nodeId: "nOTHER", nodeName: "laptop", login: "kim@example.com" });
		const response = await post("/api/pair", { name: "x" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "identity_mismatch" });
		expect(host.devices.list()).toEqual([]);
	});

	it("asks the desktop first when the setting is on, applies the grants it picked and sends no notice", async () => {
		confirmNew = true;
		const original = host.confirmations.respond.bind(host.confirmations);
		vi.spyOn(host.confirmations, "respond").mockImplementation(response =>
			original({ ...response, grants: ["workspace", "device-self"] }),
		);
		const paired = await pair();
		expect(host.devices.get(paired.deviceId)?.grants).toEqual(["workspace", "device-self"]);
		const [request] = sent(WEB_PAIRING_REQUEST) as WebPairingRequest[];
		expect(request).toMatchObject({ name: "s25u", tailscaleLogin: LOGIN, ip: PEER_IP });
		expect(request?.grants).not.toContain("pairing-admin");
		expect(sent(WEB_DEVICE_CONNECTED)).toEqual([]);
	});

	it("makes no device when the desktop declines", async () => {
		confirmNew = true;
		approve = false;
		const response = await post("/api/pair", { name: "x" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "declined" });
		expect(host.devices.list()).toEqual([]);
		expect(sent(WEB_DEVICE_CONNECTED)).toEqual([]);
	});

	it("rejects a malformed body, a wrong content type and a private key", async () => {
		expect((await post("/api/pair", { name: 5 })).status).toBe(400);
		const text = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "text/plain", origin: origin() },
			body: "x",
		});
		expect(text.status).toBe(415);
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const leaked = await post("/api/pair", { name: "x", publicKeyJwk: privateKey.export({ format: "jwk" }) });
		expect(leaked.status).toBe(400);
		expect(host.devices.list()).toEqual([]);
	});

	it("limits an address to 10 tries a minute and the host to 20 new devices an hour", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 11; i++) statuses.push((await post("/api/pair", { name: "x" })).status);
		expect(statuses.filter(status => status === 200)).toHaveLength(10);
		expect(statuses.at(-1)).toBe(429);
		for (let i = 0; i < 10; i++) {
			const response = await post("/api/pair", { name: "x" }, { "x-forwarded-for": `100.64.2.${i}` });
			expect(response.status).toBe(200);
		}
		const capped = await post("/api/pair", { name: "x" }, { "x-forwarded-for": "100.64.3.1" });
		expect(capped.status).toBe(429);
		expect(capped.headers.get("retry-after")).toBe("3600");
		expect(host.devices.list()).toHaveLength(20);
	});
});

describe("which account may open the page", () => {
	it("tells a login that is not allowed which account to use, in the browser's language", async () => {
		const other = { "tailscale-user-login": "kim@example.com" };
		const english = await raw("/", other);
		expect(english.status).toBe(403);
		expect(english.headers["content-type"]).toContain("text/html");
		expect(english.headers["cache-control"]).toBe("no-store");
		expect(english.body).toContain("kim@example.com");
		expect(english.body).toContain(LOGIN);
		expect(english.body).toContain('data-refusal="user-not-allowed"');
		const korean = await raw("/pair", { ...other, "accept-language": "ko-KR,ko;q=0.9" });
		expect(korean.status).toBe(403);
		expect(korean.body).toContain("이 계정으로는 열 수 없어요");
		expect(korean.body).not.toContain(PAGE);
	});

	it("answers an API call of a login that is not allowed with a JSON error and makes no device", async () => {
		const response = await post("/api/pair", { name: "x" }, { "tailscale-user-login": "kim@example.com" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "tailscale_user_not_allowed" });
		expect(host.devices.list()).toEqual([]);
		expect(sent(WEB_DEVICE_CONNECTED)).toEqual([]);
	});

	it("refuses a request with no Tailscale login (a tagged device) and says so on the page", async () => {
		const response = await post("/api/pair", { name: "x" }, { "tailscale-user-login": "" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "no_tailscale_user" });
		const page = await raw("/", { "tailscale-user-login": "" });
		expect(page.status).toBe(403);
		expect(page.body).toContain('data-refusal="no-user"');
		expect(host.devices.list()).toEqual([]);
	});

	it("lets a login in once the user allows it", async () => {
		allowed = [LOGIN, "kim@example.com"];
		expect((await raw("/", { "tailscale-user-login": "kim@example.com" })).status).toBe(200);
	});

	it("never serves a Funnel request, whatever login it claims", async () => {
		const funnel = { "tailscale-funnel-request": "?1" };
		expect((await raw("/", funnel)).status).toBe(403);
		expect((await post("/api/pair", { name: "x" }, funnel)).status).toBe(403);
		expect(host.devices.list()).toEqual([]);
	});
});

describe("headers forged on the loopback", () => {
	it("trusts nothing that did not come through serve: no prefix, a wrong prefix or no secret yet is a 404", async () => {
		// A local process can write Tailscale-User-Login and X-Forwarded-For, but not the prefix serve adds.
		const direct = `http://127.0.0.1:${port}`;
		const forged = { "content-type": "application/json", origin: origin(), ...IDENTITY };
		const pairDirect = await realFetch(`${direct}/api/pair`, { method: "POST", headers: forged, body: "{}" });
		expect(pairDirect.status).toBe(404);
		expect((await rawAt("/")).status).toBe(404);
		expect((await rawAt("/pair")).status).toBe(404);
		expect((await rawAt("/healthz")).status).toBe(404);
		expect((await rawAt("/assets/app-abc.js")).status).toBe(404);
		expect((await rawAt(`/${SECRET.slice(0, -1)}X/api/pair`, {}, "POST")).status).toBe(404);
		expect((await rawAt(`/x/${SECRET}/`)).status).toBe(404);
		expect(host.devices.list()).toEqual([]);
		expect(sent(WEB_DEVICE_CONNECTED)).toEqual([]);
		// Not even the page that names an account: nothing answers without the prefix.
		expect((await rawAt("/", { "tailscale-user-login": "kim@example.com" })).body).not.toContain("kim@example.com");
		host.server.configure({ servePrefix: null });
		expect((await raw("/")).status).toBe(404);
	});

	it("answers 503 under its own secret until serve's handler is confirmed, so a page whose host just restarted retries instead of giving a chunk up", async () => {
		host.server.configure({ servePrefix: null });
		const own = host.serveSecret();
		expect((await rawAt(`/${own}/assets/app-abc.js`)).status).toBe(503);
		expect((await rawAt(`/${own}/`)).status).toBe(503);
		expect((await rawAt(`/${own}/api/session`, { origin: origin() }, "POST")).status).toBe(503);
		// Without it, nothing has changed: a bare 404 and no header read.
		expect((await rawAt("/assets/app-abc.js")).status).toBe(404);
		expect((await raw("/")).status).toBe(404);
		expect(host.devices.list()).toEqual([]);
	});

	it("refuses a WebSocket upgrade without the prefix", async () => {
		const paired = await pair();
		const ticket = await ticketFor(paired);
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ompdesk.v1", `ticket.${ticket}`], {
			headers: { origin: origin(), cookie: paired.cookie, ...IDENTITY },
		});
		sockets.push(socket);
		const status = await new Promise<number>(resolve => {
			socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
			socket.once("error", () => resolve(0));
		});
		expect(status).toBe(404);
	});
});

describe("blocking a device", () => {
	const list = async () => (await handlers.get(WEB_DEVICES_LIST)?.({} as IpcCaller)) as WebDeviceInfo[];
	const blockedList = async () => (await handlers.get(WEB_BLOCKS_LIST)?.({} as IpcCaller)) as WebBlockedInfo[];

	it("keeps a revoked device out: its cookie, the page and a new connection are all refused until it is unblocked", async () => {
		const paired = await pair();
		expect(await list()).toMatchObject([{ id: paired.deviceId, blockScope: "node" }]);
		const left = await handlers.get(WEB_DEVICES_REVOKE)?.({} as IpcCaller, paired.deviceId);
		expect(left).toEqual([]);
		expect(host.devices.list()).toEqual([]);
		expect((await post("/api/session", {}, { cookie: paired.cookie })).status).toBe(401);

		const page = await raw("/", { "accept-language": "ko" });
		expect(page.status).toBe(403);
		expect(page.body).toContain("이 기기는 차단됐어요");
		expect(page.body).toContain('data-refusal="blocked-node"');
		const again = await post("/api/pair", { name: "x" });
		expect(again.status).toBe(403);
		expect(await again.json()).toEqual({ error: "blocked" });
		expect(host.devices.list()).toEqual([]);

		const blocked = await blockedList();
		expect(blocked).toMatchObject([{ scope: "node", name: "s25u", tailscaleLogin: LOGIN }]);
		const afterUnblock = await handlers.get(WEB_BLOCKS_REMOVE)?.({} as IpcCaller, blocked[0]?.id);
		expect(afterUnblock).toEqual([]);
		expect((await raw("/")).status).toBe(200);
		expect((await pair()).deviceId).not.toBe(paired.deviceId);
	});

	it("blocks the node, not the login: another device of the same login still connects", async () => {
		const first = await pair();
		peers.set("100.64.0.10", { nodeId: "nTABLET", nodeName: "tablet", login: LOGIN });
		const tablet = await post("/api/pair", { name: "t" }, { "x-forwarded-for": "100.64.0.10" });
		expect(tablet.status).toBe(200);
		await handlers.get(WEB_DEVICES_REVOKE)?.({} as IpcCaller, first.deviceId);
		expect(host.devices.list().map(device => device.name)).toEqual(["tablet"]);
		const visit = await raw("/", { "x-forwarded-for": "100.64.0.10" });
		expect(visit.status).toBe(200);
		expect((await raw("/")).status).toBe(403);
	});

	it("revokes every record of the blocked node, closing its sockets with 4401", async () => {
		const first = await pair({ name: "Safari" });
		await pair({ name: "Home Screen app" });
		const { socket, frames } = await open(first, await ticketFor(first));
		await until(() => frames.length > 0);
		const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
		await handlers.get(WEB_DEVICES_REVOKE)?.({} as IpcCaller, first.deviceId);
		expect(await closed).toBe(4401);
		expect(host.devices.list()).toEqual([]);
	});

	it("lets a device with a cookie keep working while whois is down", async () => {
		const first = await pair();
		peers.set("100.64.0.10", { nodeId: "nTABLET", nodeName: "tablet", login: LOGIN });
		const tablet = await post("/api/pair", { name: "t" }, { "x-forwarded-for": "100.64.0.10" });
		const tabletCookie = (tablet.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		await handlers.get(WEB_DEVICES_REVOKE)?.({} as IpcCaller, first.deviceId);
		peers.clear();
		expect((await raw("/", { cookie: tabletCookie, "x-forwarded-for": "100.64.0.10" })).status).toBe(200);
		// A visit that cannot be told apart from the blocked node is held back too.
		expect((await raw("/", { "x-forwarded-for": "100.64.0.99" })).status).toBe(403);
	});

	it("falls back to blocking the login when whois gave no node identity, and says so in the device list", async () => {
		allowed = [LOGIN, "kim@example.com"];
		peers.set(PEER_IP, { nodeId: null, nodeName: "s25u", login: LOGIN });
		const paired = await pair();
		expect(await list()).toMatchObject([{ id: paired.deviceId, blockScope: "login" }]);
		await handlers.get(WEB_DEVICES_REVOKE)?.({} as IpcCaller, paired.deviceId);
		expect(await blockedList()).toMatchObject([{ scope: "login", tailscaleLogin: LOGIN }]);
		const page = await raw("/", { "x-forwarded-for": "100.64.0.50" });
		expect(page.status).toBe(403);
		expect(page.body).toContain('data-refusal="blocked-login"');
		expect((await post("/api/pair", { name: "x" }, { "x-forwarded-for": "100.64.0.50" })).status).toBe(403);
		// Another account is not caught by it.
		const other = await post(
			"/api/pair",
			{ name: "x" },
			{ "tailscale-user-login": "kim@example.com", "x-forwarded-for": "100.64.0.51" },
		);
		expect(other.status).toBe(200);
	});
});

describe("session tickets", () => {
	it("refuses a request without a valid cookie and counts only the ones that carry a bad cookie", async () => {
		// A first visit has no cookie yet (it connects next): that is not a stranger.
		expect((await post("/api/session", {})).status).toBe(401);
		const forged = await post("/api/session", {}, { cookie: "ompdesk=abc.def" });
		expect(forged.status).toBe(401);
		expect(forged.headers.get("set-cookie")).toContain("Max-Age=0");
		expect((await post("/api/session", {}, { cookie: "ompdesk=nodot" })).status).toBe(401);
		expect(unpaired).not.toHaveBeenCalled();
		expect((await post("/api/session", {}, { cookie: "ompdesk=abc.xyz" })).status).toBe(401);
		expect(unpaired).toHaveBeenCalledTimes(1);
	});

	it("makes the device sign a nonce with its key before it gets a ticket, once per nonce", async () => {
		const paired = await pair();
		const first = await post("/api/session", {}, { cookie: paired.cookie });
		const { nonce, ticket } = (await first.json()) as { nonce?: string; ticket?: string };
		expect(ticket).toBeUndefined();
		if (!nonce || !paired.privateKey) throw new Error("no nonce");
		const wrongKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
		const forged = sign("sha256", Buffer.from(nonce), { key: wrongKey, dsaEncoding: "ieee-p1363" }).toString(
			"base64url",
		);
		expect((await post("/api/session", { nonce, sig: forged }, { cookie: paired.cookie })).status).toBe(401);
		// The nonce is spent by the failed try.
		const good = sign("sha256", Buffer.from(nonce), { key: paired.privateKey, dsaEncoding: "ieee-p1363" }).toString(
			"base64url",
		);
		expect((await post("/api/session", { nonce, sig: good }, { cookie: paired.cookie })).status).toBe(401);
		expect(typeof (await ticketFor(paired))).toBe("string");
	});

	it("gives a device registered without a key (plain HTTP) its ticket directly", async () => {
		const paired = await pair({ withKey: false });
		const response = await post("/api/session", {}, { cookie: paired.cookie });
		expect(await response.json()).toMatchObject({ ticket: expect.any(String), expiresAt: expect.any(Number) });
	});

	it("limits a device to 20 session requests a minute", async () => {
		const paired = await pair({ withKey: false });
		const statuses: number[] = [];
		for (let i = 0; i < 22; i++) statuses.push((await post("/api/session", {}, { cookie: paired.cookie })).status);
		expect(statuses.filter(status => status === 200)).toHaveLength(20);
		expect(statuses.at(-1)).toBe(429);
	});
});

describe("WebSocket", () => {
	beforeEach(() => {
		handlers.set(IPC_COMMANDS.SESSIONS_LIST, (caller, ...args) => ({
			win: caller.win?.webContents.id,
			browserWindow: caller.browserWindow,
			args,
		}));
	});

	it("sends hello, then answers an invoke of a passthrough channel with the device's virtual window as the caller", async () => {
		const paired = await pair();
		const { socket, frames } = await open(paired, await ticketFor(paired));
		await until(() => frames.length > 0);
		expect(frames[0]).toMatchObject({ t: "hello", protocol: 1, resumed: false, features: { upload: true } });
		socket.send(JSON.stringify({ t: "inv", id: 5, ch: IPC_COMMANDS.SESSIONS_LIST, a: [{ scope: "global" }] }));
		await until(() => frames.some(frame => frame.t === "res"));
		const res = frames.find(frame => frame.t === "res");
		expect(res).toMatchObject({ t: "res", id: 5, ok: true, v: { browserWindow: null, args: [{ scope: "global" }] } });
		expect((res as { v: { win: number } }).v.win).toBeLessThan(0);
		expect(host.router.isConnected(paired.deviceId)).toBe(true);
	});

	it("refuses a policy-boundary channel and a missing handler with an error frame", async () => {
		const paired = await pair();
		const { socket, frames } = await open(paired, await ticketFor(paired));
		socket.send(JSON.stringify({ t: "inv", id: 1, ch: WEB_DEVICES_LIST, a: [] }));
		socket.send(JSON.stringify({ t: "inv", id: 2, ch: IPC_COMMANDS.SESSIONS_RENAME, a: [] }));
		await until(() => frames.filter(frame => frame.t === "res").length === 2);
		const results = frames.filter(frame => frame.t === "res");
		expect(results[0]).toMatchObject({ id: 1, ok: false, e: { code: "web_forbidden" } });
		expect(results[1]).toMatchObject({ id: 2, ok: false });
	});

	it("accepts a ticket once, bound to the browser that asked for it", async () => {
		const paired = await pair();
		const ticket = await ticketFor(paired);
		await expect(open(paired, ticket, { "user-agent": "Other/2" })).rejects.toThrow("401");
		const again = await ticketFor(paired);
		await open(paired, again);
		await expect(open(paired, again)).rejects.toThrow("401");
	});

	it("refuses an upgrade without the cookie, with a wrong Origin or Host, or without a ticket", async () => {
		const paired = await pair();
		await expect(open(null, await ticketFor(paired))).rejects.toThrow("401");
		await expect(open(paired, await ticketFor(paired), { origin: "http://evil.example" })).rejects.toThrow("403");
		await expect(open(paired, await ticketFor(paired), { host: "evil.example" })).rejects.toThrow("421");
		await expect(open(paired, "not-a-ticket")).rejects.toThrow("401");
	});

	it("allows four sockets a device and refuses the fifth", async () => {
		const paired = await pair();
		for (let i = 0; i < 4; i++) await open(paired, await ticketFor(paired));
		await expect(open(paired, await ticketFor(paired))).rejects.toThrow("429");
	});

	it("closes the device's sockets with 4401 on revoke, destroys its window and its upload folder", async () => {
		const paired = await pair();
		const { socket, frames } = await open(paired, await ticketFor(paired));
		await until(() => frames.length > 0);
		const win = host.windows.windowFor(paired.deviceId);
		const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
		const released = vi.fn();
		win.once("closed", released);
		const uploaded = await upload(paired, "a.txt", "data");
		expect(existsSync(uploaded.path)).toBe(true);
		const result = await handlers.get(WEB_DEVICES_LIST)?.({} as IpcCaller);
		expect(result as WebDeviceInfo[]).toMatchObject([{ id: paired.deviceId, connected: true }]);
		host.devices.revoke(paired.deviceId);
		expect(await closed).toBe(4401);
		expect(released).toHaveBeenCalledOnce();
		await until(() => !existsSync(uploaded.path));
		expect((await post("/api/session", {}, { cookie: paired.cookie })).status).toBe(401);
	});

	it("closes sockets with 1001 when the server stops", async () => {
		const paired = await pair();
		const { socket } = await open(paired, await ticketFor(paired));
		const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
		await host.stop();
		expect(await closed).toBe(1001);
	});
});

async function upload(paired: Paired, name: string, content: string, headers: Record<string, string> = {}) {
	const form = new FormData();
	form.set("file", new File([content], name));
	const response = await fetch(`${base}/upload`, {
		method: "POST",
		headers: { origin: origin(), cookie: paired.cookie, ...headers },
		body: form,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { path: string; name: string; size: number };
}

describe("uploads and blobs", () => {
	it("stores an upload on the host and returns its path; refuses without a cookie or over the limit", async () => {
		const paired = await pair();
		const stored = await upload(paired, "../note.txt", "hello");
		expect(stored).toMatchObject({ name: "note.txt", size: 5 });
		expect(readFileSync(stored.path, "utf8")).toBe("hello");
		expect(stored.path).toContain(join("web-uploads", paired.deviceId));
		const form = new FormData();
		form.set("file", new File(["x"], "x.txt"));
		expect(
			(await fetch(`${base}/upload`, { method: "POST", headers: { origin: origin() }, body: form })).status,
		).toBe(401);
		const big = new FormData();
		big.set("file", new File([new Uint8Array(26 * 1024 * 1024)], "big.bin"));
		expect(
			(
				await fetch(`${base}/upload`, {
					method: "POST",
					headers: { origin: origin(), cookie: paired.cookie },
					body: big,
				})
			).status,
		).toBe(413);
		expect(
			(
				await fetch(`${base}/upload`, {
					method: "POST",
					headers: { origin: origin(), cookie: paired.cookie, "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(415);
	});

	it("serves a host file over /blob with Range to its device only", async () => {
		const file = join(userData, "clip.bin");
		writeFileSync(file, "0123456789");
		const paired = await pair();
		const { socket, frames } = await open(paired, await ticketFor(paired));
		socket.send(JSON.stringify({ t: "inv", id: 1, ch: WEB_HOST_CHANNELS.BLOB_OPEN, a: [{ path: file }] }));
		await until(() => frames.some(frame => frame.t === "res"));
		const opened = (frames.find(frame => frame.t === "res") as { v: WebBlobOpenResult }).v;
		if (!opened.ok) throw new Error(opened.error);
		const part = await fetch(`${base}${opened.url}`, {
			headers: { cookie: paired.cookie, range: "bytes=3-6", origin: origin() },
		});
		expect(part.status).toBe(206);
		expect(await part.text()).toBe("3456");
		expect((await fetch(`${base}${opened.url}`)).status).toBe(401);
		const other = await pair({ name: "Other" });
		expect((await fetch(`${base}${opened.url}`, { headers: { cookie: other.cookie } })).status).toBe(404);
	});
});

describe("unknown devices", () => {
	it("tells the desktop once after three failed authentications in a minute", async () => {
		for (let i = 0; i < 6; i++) await post("/api/session", {}, { cookie: "ompdesk=ghost.secret" });
		expect(unpaired).toHaveBeenCalledOnce();
		expect(unpaired.mock.calls[0]?.[0]).toMatchObject({ address: expect.any(String) });
	});
});

describe("/api/push", () => {
	const subscription = () => ({
		endpoint: "https://push.example.com/send/abc123",
		keys: {
			p256dh: (() => {
				const ecdh = createECDH("prime256v1");
				ecdh.generateKeys();
				return ecdh.getPublicKey().toString("base64url");
			})(),
			auth: randomBytes(16).toString("base64url"),
		},
	});
	const get = (paired: Paired) => fetch(`${base}/api/push`, { headers: { cookie: paired.cookie } });
	const change = (paired: Paired, body: unknown, headers: Record<string, string> = {}) =>
		post("/api/push", body, { cookie: paired.cookie, ...headers });

	it("needs the device's cookie", async () => {
		expect((await fetch(`${base}/api/push`)).status).toBe(401);
		expect((await post("/api/push", {})).status).toBe(401);
	});

	it("tells a device that never subscribed the host's VAPID key and the defaults", async () => {
		const paired = await pair();
		const response = await get(paired);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const state = (await response.json()) as WebPushStateResponse;
		expect(state).toEqual({
			publicKey: host.vapid.keys().publicKey,
			subscribed: false,
			hideContent: false,
			categories: ["completion", "error", "ask"],
		});
		expect(state.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
	});

	it("stores the subscription, hideContent and categories on the device record", async () => {
		const paired = await pair();
		const sub = subscription();
		const response = await change(paired, { subscription: sub, hideContent: true, categories: ["ask", "error"] });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			subscribed: true,
			hideContent: true,
			categories: ["error", "ask"],
		});
		expect(host.devices.get(paired.deviceId)?.push).toEqual({
			subscription: sub,
			hideContent: true,
			categories: ["error", "ask"],
		});
		// A partial change keeps the rest.
		await change(paired, { hideContent: false });
		expect(host.devices.get(paired.deviceId)?.push).toEqual({
			subscription: sub,
			hideContent: false,
			categories: ["error", "ask"],
		});
		expect(await (await get(paired)).json()).toMatchObject({ subscribed: true, hideContent: false });
	});

	it("unsubscribes with a null subscription and keeps the preferences", async () => {
		const paired = await pair();
		await change(paired, { subscription: subscription(), hideContent: true });
		const response = await change(paired, { subscription: null });
		expect(await response.json()).toMatchObject({ subscribed: false, hideContent: true });
		expect(host.devices.get(paired.deviceId)?.push?.subscription).toBeNull();
	});

	it("refuses an endpoint that is not a push service's https address", async () => {
		const paired = await pair();
		const sub = subscription();
		for (const endpoint of [
			"http://push.example.com/x",
			"https://127.0.0.1/x",
			"https://10.0.0.5/x",
			"https://[::1]/x",
			"https://localhost/x",
			"https://printer.local/x",
			"https://host.tail1234.ts.net/x",
			"https://singlelabel/x",
			"https://user:pass@push.example.com/x",
			"https://push.example.com:8443/x",
			"ftp://push.example.com/x",
			"not a url",
			`https://push.example.com/${"a".repeat(2100)}`,
		]) {
			const response = await change(paired, { subscription: { ...sub, endpoint } });
			expect(response.status, endpoint.slice(0, 60)).toBe(400);
		}
		expect(host.devices.get(paired.deviceId)?.push).toBeUndefined();
	});

	it("refuses malformed keys, categories and bodies", async () => {
		const paired = await pair();
		const sub = subscription();
		const bad: unknown[] = [
			{ subscription: { ...sub, keys: { ...sub.keys, p256dh: "short" } } },
			{ subscription: { ...sub, keys: { ...sub.keys, auth: "not base64url!!!!!!!!!!" } } },
			{ subscription: { ...sub, keys: { p256dh: sub.keys.p256dh } } },
			{ subscription: { endpoint: sub.endpoint } },
			{ subscription: "https://push.example.com/x" },
			{ categories: ["completion", "everything"] },
			{ categories: "ask" },
			{ hideContent: "yes" },
		];
		for (const body of bad) expect((await change(paired, body)).status, JSON.stringify(body)).toBe(400);
		expect(
			(
				await fetch(`${base}/api/push`, {
					method: "POST",
					headers: { "content-type": "text/plain", origin: origin(), cookie: paired.cookie },
					body: "{}",
				})
			).status,
		).toBe(415);
		expect(
			(
				await fetch(`${base}/api/push`, {
					method: "POST",
					headers: { "content-type": "application/json", origin: origin(), cookie: paired.cookie },
					body: JSON.stringify({ hideContent: true, pad: "x".repeat(40_000) }),
				})
			).status,
		).toBe(413);
		expect(host.devices.get(paired.deviceId)?.push).toBeUndefined();
	});

	it("checks Origin on a POST like the other device calls, and allows only GET and POST", async () => {
		const paired = await pair();
		const noOrigin = await fetch(`${base}/api/push`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: paired.cookie },
			body: "{}",
		});
		expect(noOrigin.status).toBe(403);
		expect((await change(paired, {}, { origin: "http://evil.example" })).status).toBe(403);
		for (const method of ["PUT", "DELETE"]) {
			const refused = await fetch(`${base}/api/push`, {
				method,
				headers: { "content-type": "application/json", origin: origin(), cookie: paired.cookie },
				body: method === "PUT" ? "{}" : null,
			});
			expect(refused.status, method).toBe(405);
			expect(refused.headers.get("allow")).toBe("GET, POST");
		}
	});

	it("needs the device-self grant", async () => {
		const paired = await pair();
		host.devices.setGrants(paired.deviceId, ["workspace"]);
		expect((await get(paired)).status).toBe(403);
		expect((await change(paired, { hideContent: true })).status).toBe(403);
	});

	it("limits a device to 20 requests a minute", async () => {
		const paired = await pair();
		for (let i = 0; i < 20; i++) expect((await get(paired)).status).toBe(200);
		const limited = await get(paired);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBe("60");
		// Another device has its own allowance.
		expect((await get(await pair({ name: "Other" }))).status).toBe(200);
	});

	it("goes with the device when it is revoked", async () => {
		const paired = await pair();
		await change(paired, { subscription: subscription() });
		host.devices.revoke(paired.deviceId);
		expect(host.devices.get(paired.deviceId)).toBeUndefined();
		expect(JSON.stringify(host.devices.list())).not.toContain("push.example.com");
		expect((await get(paired)).status).toBe(401);
	});

	it("announces push in hello", async () => {
		const paired = await pair();
		const { frames } = await open(paired, await ticketFor(paired));
		await until(() => frames.length > 0);
		expect(frames[0]).toMatchObject({ t: "hello", features: { push: true } });
	});
});
