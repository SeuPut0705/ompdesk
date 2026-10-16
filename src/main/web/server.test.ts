/**
 * The whole web server on an ephemeral loopback port: static allowlist, request checks, pairing with the
 * desktop's confirmation, the key-proof session ticket, a WebSocket that invokes a passthrough channel against
 * a fake handler, uploads and blobs, and revocation closing the socket. Only Electron is faked (the IPC
 * registry and the desktop window); the server, router, stores and `ws` are the real ones.
 */
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import {
	WEB_DEVICES_LIST,
	WEB_PAIRING_REQUEST,
	type WebDeviceInfo,
	type WebPairingRequest,
} from "../../shared/mobile-web";
import { WEB_HOST_CHANNELS, type WebBlobOpenResult } from "../../shared/web-host";
import type { WebServerFrame } from "../../shared/web-protocol";
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
let confirm: boolean;
let approve: boolean;
let sockets: WebSocket[];

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
	confirm = true;
	approve = true;
	sockets = [];
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
		tabs: { activeTab: () => null, cwd: () => null },
		openMedia: async () => new Response(null, { status: 404 }),
		shell: { openPath: async () => {}, reveal: () => {}, openExternal: async () => {} },
		allowedUsers: () => [],
		confirmPairing: () => confirm,
		onUnpairedAuth: unpaired,
	};
	host = new WebHost(deps);
	({ port } = await host.start({ port: 0 }));
	base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
	for (const socket of sockets) socket.terminate();
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

/** A raw request, for a path or Host that `fetch` would normalise. */
function raw(
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
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
	});
}

interface Paired {
	cookie: string;
	deviceId: string;
	privateKey: KeyObject | null;
}

async function pair(options: { withKey?: boolean; name?: string } = {}): Promise<Paired> {
	const { code } = host.pairing.issue();
	const keys = options.withKey === false ? null : generateKeyPairSync("ec", { namedCurve: "P-256" });
	const response = await post(
		"/api/pair",
		{
			code,
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
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, ["ompdesk.v1", `ticket.${ticket}`], {
			headers: {
				origin: origin(),
				"user-agent": "TestBrowser/1.0",
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

	it("does not follow a symlink out of the built folder", async () => {
		symlinkSync(join(staticRoot, "secret.txt"), join(staticRoot, "assets", "link.js"));
		const outside = mkdtempSync(join(tmpdir(), "web-outside-"));
		writeFileSync(join(outside, "x.js"), "outside");
		symlinkSync(join(outside, "x.js"), join(staticRoot, "assets", "out.js"));
		expect((await raw("/assets/out.js")).status).toBe(404);
		rmSync(outside, { recursive: true, force: true });
	});
});

describe("pairing", () => {
	it("answers 404 until a code is issued, so the endpoint tells a guesser nothing", async () => {
		expect((await post("/api/pair", { code: "ABCD-EFGH", name: "x" })).status).toBe(404);
	});

	it("pairs with the right code after the desktop approves, sets a hardened cookie and spends the code", async () => {
		const { code } = host.pairing.issue();
		const response = await post("/api/pair", { code, name: "iPhone" }, { "user-agent": "Safari/1" });
		expect(response.status).toBe(200);
		const cookie = response.headers.get("set-cookie") ?? "";
		expect(cookie).toMatch(/^ompdesk=[\w-]+\.[\w-]{43};/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(await response.json()).toMatchObject({ name: "iPhone", grants: expect.arrayContaining(["workspace"]) });
		const request = desktopSent.find(sent => sent.channel === WEB_PAIRING_REQUEST)?.payload as WebPairingRequest;
		expect(request).toMatchObject({ name: "iPhone", userAgent: "Safari/1", tailscaleLogin: null });
		expect(request.grants).not.toContain("pairing-admin");
		expect((await post("/api/pair", { code, name: "again" })).status).toBe(404);
		const [device] = host.devices.list();
		expect(device).toMatchObject({ name: "iPhone", userAgent: "Safari/1" });
		expect(device?.grants).not.toContain("pairing-admin");
	});

	it("applies the grants the desktop picked in its dialog", async () => {
		const original = host.confirmations.respond.bind(host.confirmations);
		vi.spyOn(host.confirmations, "respond").mockImplementation(response =>
			original({ ...response, grants: ["workspace", "device-self"] }),
		);
		const paired = await pair();
		expect(host.devices.get(paired.deviceId)?.grants).toEqual(["workspace", "device-self"]);
	});

	it("refuses when the desktop declines, and the code is spent", async () => {
		approve = false;
		const { code } = host.pairing.issue();
		const response = await post("/api/pair", { code, name: "x" });
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "declined" });
		expect(host.devices.list()).toEqual([]);
		expect((await post("/api/pair", { code, name: "x" })).status).toBe(404);
	});

	it("pairs without asking when the user turned the confirmation off", async () => {
		confirm = false;
		await pair();
		expect(desktopSent.filter(sent => sent.channel === WEB_PAIRING_REQUEST)).toEqual([]);
		expect(host.devices.list()).toHaveLength(1);
	});

	it("counts wrong codes, replaces the code at the fifth, backs off, and limits per address", async () => {
		const { code } = host.pairing.issue();
		const wrong = await post("/api/pair", { code: "0000-0000", name: "x" });
		expect(wrong.status).toBe(403);
		expect(await wrong.json()).toEqual({ error: "wrong_code" });
		const backoff = await post("/api/pair", { code, name: "x" });
		expect(backoff.status).toBe(429);
		expect(backoff.headers.get("retry-after")).toBe("1");
	});

	it("rejects a malformed body, a wrong content type and a private key", async () => {
		host.pairing.issue();
		expect((await post("/api/pair", { name: "no code" })).status).toBe(400);
		const text = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "text/plain", origin: origin() },
			body: "x",
		});
		expect(text.status).toBe(415);
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
		const { code } = host.pairing.issue();
		const leaked = await post("/api/pair", { code, name: "x", publicKeyJwk: privateKey.export({ format: "jwk" }) });
		expect(leaked.status).toBe(400);
	});
});

describe("session tickets", () => {
	it("refuses a request without a valid cookie and counts it", async () => {
		expect((await post("/api/session", {})).status).toBe(401);
		const forged = await post("/api/session", {}, { cookie: "ompdesk=abc.def" });
		expect(forged.status).toBe(401);
		expect(forged.headers.get("set-cookie")).toContain("Max-Age=0");
		expect((await post("/api/session", {}, { cookie: "ompdesk=nodot" })).status).toBe(401);
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
