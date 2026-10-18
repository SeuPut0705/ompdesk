/**
 * The mobile web server: HTTP and WebSocket on `127.0.0.1` only (`tailscale serve` publishes it to the tailnet
 * with HTTPS, its target carrying a per-install secret path that this server strips). Serves the built renderer
 * from an allowlist, `/api/pair` (the first visit of an allowed Tailscale login makes its device and cookie; no
 * code), `/api/session` (a 30-second single-use WebSocket ticket, after the device proves its key), `/ws`,
 * `/blob/<token>` and `/upload`. Every request first passes auth.ts's checks; every device call then needs the
 * device's cookie. CORS headers are never sent.
 */
import { createHash, type JsonWebKey } from "node:crypto";
import { promises as fsp } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants } from "node:zlib";
import { type RawData, WebSocketServer } from "ws";
import { z } from "zod";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import { WEB_PUSH_CATEGORIES, type WebPushSettings, type WebPushStateResponse } from "../../shared/web-push";
import type { TailnetPeer } from "../tailscale/whois";
import {
	checkRequest,
	clearedDeviceCookie,
	deviceCookieValue,
	isLoopbackAddress,
	OneTimeTokens,
	originOf,
	parsePublicKeyJwk,
	type RequestCheck,
	type RequestKind,
	type RequestPolicy,
	serializeDeviceCookie,
	stripServePrefix,
	TICKET_TTL_MS,
	verifyDeviceProof,
} from "./auth";
import { BLOB_URL_PREFIX, type BlobStore } from "./blobs";
import type { BlockVerdict, WebBlocks } from "./blocks-store";
import { pushSettingsOf, type WebDevice, type WebDevices } from "./devices-store";
import type { PairingConfirmations } from "./pairing";
import { isPushEndpoint } from "./push";
import { PairingGuard, SlidingWindowLimiter, UnpairedThrottle } from "./rate-limit";
import { refusalPage } from "./refusal-page";
import { UploadError, type UploadStore } from "./uploads";
import { MAX_FRAME_BYTES, type RouterSocket, type WsRouter } from "./ws-router";

export const WEB_SERVER_HOST = "127.0.0.1";
const JSON_BODY_MAX_BYTES = 32 * 1024;
const SESSION_REQUESTS_PER_MINUTE = 20;
const PUSH_REQUESTS_PER_MINUTE = 20;
/** New devices made in an hour, over all of them: a loop of cleared cookies cannot fill the list. */
const NEW_DEVICES_PER_HOUR = 20;
/** How long a whois answer is reused for one tailnet address. */
const PEER_CACHE_MS = 60_000;
const PEER_CACHE_MAX = 256;
/** Compressed copies of static files kept in memory, in bytes. */
const COMPRESSED_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const WS_PROTOCOL = "ompdesk.v1";
/** How long stopping waits for sockets to finish their close handshake. */
const CLOSE_GRACE_MS = 1000;

const brotli = promisify(brotliCompress);

/** The renderer's built files a browser may be handed. */
const STATIC_DIRS = ["/assets/", "/cmaps/", "/standard_fonts/", "/wasm/", "/icons/", "/screenshots/"] as const;
const STATIC_FILES: ReadonlySet<string> = new Set([
	"/manifest.webmanifest",
	"/sw.js",
	"/pre-paint.js",
	"/favicon.ico",
	"/apple-touch-icon.png",
]);
/** Pages of the single-page app: both are `web.html`. */
const PAGE_ROUTES: ReadonlySet<string> = new Set(["/", "/pair"]);
const PAGE_FILE = "web.html";

const MIME: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".jpg": "image/jpeg",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".map": "application/json; charset=utf-8",
	".bcmap": "application/octet-stream",
	".pfb": "application/octet-stream",
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|wasm)|image\/svg\+xml)/;

/** A failed request: the status and the JSON `{error}` the page reads. */
class HttpError extends Error {
	readonly status: number;
	readonly headers: Record<string, string>;
	constructor(status: number, error: string, headers: Record<string, string> = {}) {
		super(error);
		this.name = "HttpError";
		this.status = status;
		this.headers = headers;
	}
}

/** `POST /api/pair`: the device's own name (a fallback for whois') and its public key; no code. */
const PairBody = z.object({
	name: z.string().max(200).default(""),
	clientInstanceId: z.string().max(128).optional(),
	publicKeyJwk: z.unknown().optional(),
});
const SessionBody = z.object({ nonce: z.string().max(128).optional(), sig: z.string().max(256).optional() });
/** A browser's `PushSubscription.toJSON()`: the P-256 point (65 bytes) and the auth secret (16 bytes), base64url. */
const PushBody = z.object({
	subscription: z
		.object({
			endpoint: z.string().max(2048),
			keys: z.object({
				p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
				auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
			}),
		})
		.nullable()
		.optional(),
	hideContent: z.boolean().optional(),
	categories: z.array(z.enum(WEB_PUSH_CATEGORIES)).max(WEB_PUSH_CATEGORIES.length).optional(),
});

export interface WebServerDeps {
	/** Mutable: `configure` changes the published address as Tailscale reports it. */
	policy: RequestPolicy;
	devices: WebDevices;
	blocks: WebBlocks;
	confirmations: PairingConfirmations;
	/** Hold a new device until the desktop approves it (Settings, off by default). */
	confirmNewDevices: () => boolean;
	/** The node and user behind a tailnet address (`tailscale whois`); null when it does not know. */
	whois: (address: string) => Promise<TailnetPeer | null>;
	/** A device was just made without asking the desktop: it is told once, with the way to block it. */
	onDeviceConnected: (device: WebDevice) => void;
	router: WsRouter;
	uploads: UploadStore;
	blobs: BlobStore;
	/** The folder holding the built renderer's `web.html` and assets; null while there is none. */
	staticRoot: () => string | null;
	/** A device authentication failed three times within a minute; told once. */
	onUnpairedAuth?: (info: { address: string }) => void;
	/** Web Push: the VAPID public key a page subscribes against. */
	push: { publicKey: () => string };
	now?: () => number;
}

interface ConfigurablePolicy {
	host?: string;
	publicPort?: number;
	secure?: boolean;
	servePrefix?: string | null;
}

/** The Tailscale address serve put in `X-Forwarded-For` (it sets it itself, over any value the client sent), or null. */
function tailnetAddress(req: IncomingMessage): string | null {
	const forwarded = singleHeader(req.headers["x-forwarded-for"])?.split(",")[0]?.trim();
	return forwarded && isIP(forwarded) !== 0 ? forwarded : null;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function uaHash(req: IncomingMessage): string {
	return createHash("sha256")
		.update(singleHeader(req.headers["user-agent"]) ?? "")
		.digest("hex");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(Buffer.byteLength(text)),
		"cache-control": "no-store",
		...headers,
	});
	res.end(text);
}

function sendStatus(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
	res.end(http.STATUS_CODES[status] ?? "");
}

/** A small HTML answer (the refusal pages): its own CSP allows only inline style, nothing is cached. */
function sendHtml(res: ServerResponse, status: number, html: string): void {
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"content-length": String(Buffer.byteLength(html)),
		"cache-control": "no-store",
		"content-security-policy":
			"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
	});
	res.end(html);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	if (!/^application\/json\b/i.test(singleHeader(req.headers["content-type"]) ?? "")) {
		throw new HttpError(415, "expected application/json");
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > JSON_BODY_MAX_BYTES) throw new HttpError(413, "body too large");
		chunks.push(buffer);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "invalid json");
	}
}

/** The peer address for limits and notices: serve's `X-Forwarded-For` (one Tailscale IP), else the socket's. */
function sourceAddress(req: IncomingMessage): string {
	const forwarded = singleHeader(req.headers["x-forwarded-for"])?.split(",")[0]?.trim();
	return forwarded && /^[0-9a-fA-F:.]{3,45}$/.test(forwarded) ? forwarded : (req.socket.remoteAddress ?? "unknown");
}

function bufferOf(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

export class WebServer {
	readonly #deps: WebServerDeps;
	readonly #now: () => number;
	readonly #tickets = new OneTimeTokens<{ deviceId: string; ua: string }>(TICKET_TTL_MS);
	readonly #nonces = new OneTimeTokens<string>(TICKET_TTL_MS);
	readonly #sessionLimiter: SlidingWindowLimiter;
	readonly #pairGuard: PairingGuard;
	readonly #unpaired: UnpairedThrottle;
	readonly #pushLimiter: SlidingWindowLimiter;
	readonly #enrollLimiter: SlidingWindowLimiter;
	readonly #peers = new Map<string, { peer: TailnetPeer; at: number }>();
	readonly #wss = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_FRAME_BYTES,
		perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 } },
		handleProtocols: protocols => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
	});
	readonly #compressed = new Map<string, Buffer>();
	#compressedBytes = 0;
	#server: http.Server | null = null;
	#port: number | null = null;

	constructor(deps: WebServerDeps) {
		this.#deps = deps;
		this.#now = deps.now ?? Date.now;
		this.#sessionLimiter = new SlidingWindowLimiter(SESSION_REQUESTS_PER_MINUTE, 60_000, this.#now);
		this.#pushLimiter = new SlidingWindowLimiter(PUSH_REQUESTS_PER_MINUTE, 60_000, this.#now);
		this.#enrollLimiter = new SlidingWindowLimiter(NEW_DEVICES_PER_HOUR, 60 * 60_000, this.#now);
		this.#pairGuard = new PairingGuard(this.#now);
		this.#unpaired = new UnpairedThrottle(this.#now);
	}

	/** The loopback port while listening, else null. */
	get port(): number | null {
		return this.#port;
	}

	/** Change the address the server answers to (Tailscale reported a name, serve moved to another port). */
	configure(change: ConfigurablePolicy): void {
		Object.assign(this.#deps.policy, change);
	}

	/** Listen on the loopback; `port` 0 picks a free one. Rejects when the port is taken. */
	async start(options: { port?: number } = {}): Promise<{ port: number }> {
		if (this.#server) return { port: this.#port ?? 0 };
		const server = http.createServer((req, res) => void this.#handle(req, res));
		server.headersTimeout = 15_000;
		server.requestTimeout = 120_000;
		server.keepAliveTimeout = 5_000;
		server.on("upgrade", (req, socket, head) => this.#upgrade(req, socket, head));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, WEB_SERVER_HOST, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.#server = server;
		const address = server.address();
		this.#port = typeof address === "object" && address ? address.port : (options.port ?? 0);
		return { port: this.#port };
	}

	async stop(): Promise<void> {
		const server = this.#server;
		if (!server) return;
		this.#server = null;
		this.#port = null;
		this.#deps.confirmations.declineAll();
		const clients = [...this.#wss.clients];
		const closed = Promise.all(
			clients.map(client => new Promise<void>(resolve => client.once("close", () => resolve()))),
		);
		this.#deps.router.closeAll(1001, "server stopping");
		// A close handshake needs a moment; a peer that does not answer is cut off.
		const grace = Promise.withResolvers<void>();
		const timer = setTimeout(grace.resolve, CLOSE_GRACE_MS);
		await Promise.race([closed, grace.promise]);
		clearTimeout(timer);
		for (const client of clients) client.terminate();
		const done = Promise.withResolvers<void>();
		server.close(() => done.resolve());
		server.closeAllConnections();
		await done.promise;
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			await this.#route(req, res);
		} catch (error) {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			if (error instanceof HttpError) sendJson(res, error.status, { error: error.message }, error.headers);
			else if (error instanceof UploadError) sendJson(res, error.status, { error: error.message });
			else sendJson(res, 500, { error: "internal" });
		}
	}

	#check(req: IncomingMessage, kind: RequestKind): RequestCheck {
		return checkRequest({
			headers: req.headers,
			method: req.method ?? "GET",
			kind,
			url: req.url ?? "/",
			remoteAddress: req.socket.remoteAddress,
			policy: this.#deps.policy,
		});
	}

	/** A walled request: a status, or for a login Tailscale vouches for but we do not allow, the page that says so. */
	#refuse(
		req: IncomingMessage,
		res: ServerResponse,
		check: Extract<RequestCheck, { ok: false }>,
		kind: RequestKind,
	): void {
		if (check.why === "other") {
			sendStatus(res, check.status);
			return;
		}
		if (kind !== "page") {
			sendJson(res, 403, {
				error: check.why === "user not allowed" ? "tailscale_user_not_allowed" : "no_tailscale_user",
			});
			return;
		}
		sendHtml(
			res,
			403,
			refusalPage({
				kind: check.why === "user not allowed" ? "user-not-allowed" : "no-user",
				login: check.login,
				allowed: this.#deps.policy.allowedUsers(),
				acceptLanguage: singleHeader(req.headers["accept-language"]),
			}),
		);
	}

	/** A blocked device (or login): the page that says so, or the JSON error of an API call. */
	#refuseBlocked(
		req: IncomingMessage,
		res: ServerResponse,
		verdict: Exclude<BlockVerdict, null>,
		kind: RequestKind,
		login: string,
	): void {
		if (kind !== "page") {
			sendJson(res, 403, { error: "blocked" });
			return;
		}
		const loginScope = verdict !== "unidentified" && verdict.scope === "login";
		sendHtml(
			res,
			403,
			refusalPage({
				kind: loginScope ? "blocked-login" : "blocked-node",
				login,
				allowed: this.#deps.policy.allowedUsers(),
				acceptLanguage: singleHeader(req.headers["accept-language"]),
			}),
		);
	}

	/** whois for a tailnet address, reused for a minute; a failed answer is not kept. */
	async #peer(address: string): Promise<TailnetPeer | null> {
		const now = this.#now();
		const cached = this.#peers.get(address);
		if (cached && now - cached.at < PEER_CACHE_MS) return cached.peer;
		let peer: TailnetPeer | null = null;
		try {
			peer = await this.#deps.whois(address);
		} catch {
			peer = null;
		}
		if (peer) {
			if (this.#peers.size >= PEER_CACHE_MAX) this.#peers.clear();
			this.#peers.set(address, { peer, at: now });
		}
		return peer;
	}

	/** Whether the request carries the cookie of a device that still exists. */
	#hasDevice(req: IncomingMessage): boolean {
		const cookie = deviceCookieValue(req.headers, this.#deps.policy.secure);
		return cookie !== null && this.#deps.devices.authenticate(cookie).ok;
	}

	async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const method = req.method ?? "GET";
		const { policy } = this.#deps;
		// Only a request that came through serve carries the secret prefix; everything below sees it taken off.
		const stripped = policy.servePrefix === null ? null : stripServePrefix(req.url ?? "/", policy.servePrefix);
		const queryAt = (stripped ?? "/").indexOf("?");
		const pathname = queryAt === -1 ? (stripped ?? "/") : (stripped ?? "/").slice(0, queryAt);

		const isApi =
			pathname === "/api/pair" ||
			pathname === "/api/session" ||
			pathname === "/api/push" ||
			pathname === "/upload" ||
			pathname === "/healthz" ||
			pathname.startsWith(BLOB_URL_PREFIX);
		const kind: RequestKind = isApi ? "api" : "page";
		const check = this.#check(req, kind);
		if (!check.ok) {
			this.#refuse(req, res, check, kind);
			return;
		}
		const target = check.target;
		req.url = target;
		// A blocked device must not reach the app: a page load without a device cookie asks who the visitor is.
		if (PAGE_ROUTES.has(pathname) && this.#deps.blocks.active && !this.#hasDevice(req)) {
			const address = tailnetAddress(req);
			const peer = address ? await this.#peer(address) : null;
			const verdict = this.#deps.blocks.check({ nodeId: peer?.nodeId ?? null, login: check.login });
			if (verdict !== null) {
				this.#refuseBlocked(req, res, verdict, kind, check.login);
				return;
			}
		}

		if (pathname === "/healthz") {
			if (method !== "GET") throw new HttpError(405, "method not allowed");
			sendJson(res, 200, { ok: true });
			return;
		}
		if (pathname === "/api/pair") return this.#pair(req, res, method, check.login);
		if (pathname === "/api/session") return this.#session(req, res, method);
		if (pathname === "/api/push") return this.#push(req, res, method);
		if (pathname === "/upload") return this.#upload(req, res, method);
		if (pathname.startsWith(BLOB_URL_PREFIX)) return this.#blob(req, res, method, target);
		if (pathname.startsWith("/api/")) throw new HttpError(404, "not found");
		return this.#static(req, res, method, pathname);
	}

	/** The device behind the request's cookie; a failure is counted, and told to the desktop once it repeats. */
	#device(req: IncomingMessage): WebDevice {
		const { policy, devices } = this.#deps;
		const cookie = deviceCookieValue(req.headers, policy.secure);
		const result = cookie === null ? null : devices.authenticate(cookie);
		if (result?.ok) return result.device;
		// A visit with no cookie yet is the normal first visit of a new device (it enrolls next), not a stranger.
		if (cookie !== null && this.#unpaired.record()) this.#deps.onUnpairedAuth?.({ address: sourceAddress(req) });
		const headers: Record<string, string> = {};
		if (result && result.reason !== "malformed") headers["set-cookie"] = clearedDeviceCookie(policy.secure);

		throw new HttpError(401, "unauthorized", headers);
	}

	/**
	 * `POST /api/pair`: a Tailscale login that is allowed (the walls checked it) connects its device. whois names the
	 * node (its device name and stable ID) and must agree on the login; a blocked node or login is refused; the
	 * desktop is asked first only when the user turned that on, otherwise told afterwards, once.
	 */
	async #pair(req: IncomingMessage, res: ServerResponse, method: string, login: string): Promise<void> {
		if (method !== "POST") throw new HttpError(405, "method not allowed");
		const { devices, blocks, confirmations, policy } = this.#deps;
		const address = sourceAddress(req);
		const decision = this.#pairGuard.check(address);
		if (!decision.ok) {
			throw new HttpError(429, "rate_limited", { "retry-after": String(Math.ceil(decision.retryAfterMs / 1000)) });
		}
		const parsed = PairBody.safeParse(await readJsonBody(req));
		if (!parsed.success) throw new HttpError(400, "invalid_request");
		const body = parsed.data;
		let publicKeyJwk: JsonWebKey | null = null;
		if (body.publicKeyJwk !== undefined && body.publicKeyJwk !== null) {
			publicKeyJwk = parsePublicKeyJwk(body.publicKeyJwk);
			if (!publicKeyJwk) throw new HttpError(400, "invalid_key");
		}
		const forwarded = tailnetAddress(req);
		const peer = forwarded ? await this.#peer(forwarded) : null;
		// whois reads the address serve itself put in; a different login behind it is not what the header claimed.
		if (peer?.login && peer.login.toLowerCase() !== login.toLowerCase())
			throw new HttpError(403, "identity_mismatch");
		if (blocks.check({ nodeId: peer?.nodeId ?? null, login }) !== null) throw new HttpError(403, "blocked");
		if (!this.#enrollLimiter.hit("*")) throw new HttpError(429, "rate_limited", { "retry-after": "3600" });
		const userAgent = singleHeader(req.headers["user-agent"]) ?? "";
		const name = peer?.nodeName ?? (body.name.trim() || "Phone");
		let grants = [...DEFAULT_WEB_GRANTS];
		const asked = this.#deps.confirmNewDevices();
		if (asked) {
			const outcome = await confirmations.request({ name, userAgent, tailscaleLogin: login, ip: address });
			if (!outcome.approved) {
				this.#pairGuard.fail(address);
				throw new HttpError(403, outcome.reason);
			}
			grants = outcome.grants;
		}
		this.#pairGuard.succeed(address);
		const { device, cookie } = devices.create({
			name,
			userAgent,
			tailscaleLogin: login,
			nodeId: peer?.nodeId ?? null,
			publicKeyJwk,
			grants,
		});
		if (!asked) this.#deps.onDeviceConnected(device);
		sendJson(
			res,
			200,
			{ deviceId: device.deviceId, name: device.name, grants: device.grants },
			{ "set-cookie": serializeDeviceCookie(cookie, policy.secure) },
		);
	}

	/** `GET|POST /api/push`: this device's push state; a POST changes its subscription and what it wants pushed. */
	async #push(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
		if (method !== "GET" && method !== "POST") {
			throw new HttpError(405, "method not allowed", { allow: "GET, POST" });
		}
		const device = this.#device(req);
		if (!device.grants.includes("device-self")) throw new HttpError(403, "forbidden");
		if (!this.#pushLimiter.hit(device.deviceId)) {
			throw new HttpError(429, "rate_limited", { "retry-after": "60" });
		}
		let settings = pushSettingsOf(device);
		if (method === "POST") {
			const parsed = PushBody.safeParse(await readJsonBody(req));
			if (!parsed.success) throw new HttpError(400, "invalid_request");
			const { subscription, hideContent, categories } = parsed.data;
			if (subscription && !isPushEndpoint(subscription.endpoint)) throw new HttpError(400, "invalid_endpoint");
			const next: WebPushSettings = {
				subscription:
					subscription === undefined
						? settings.subscription
						: subscription && { endpoint: subscription.endpoint, keys: { ...subscription.keys } },
				hideContent: hideContent ?? settings.hideContent,
				categories: categories
					? WEB_PUSH_CATEGORIES.filter(name => categories.includes(name))
					: settings.categories,
			};
			this.#deps.devices.setPush(device.deviceId, next);
			settings = next;
		}
		const state: WebPushStateResponse = {
			publicKey: this.#deps.push.publicKey(),
			subscribed: settings.subscription !== null,
			hideContent: settings.hideContent,
			categories: settings.categories,
		};
		sendJson(res, 200, state);
	}

	async #session(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
		if (method !== "POST") throw new HttpError(405, "method not allowed");
		const device = this.#device(req);
		if (!this.#sessionLimiter.hit(device.deviceId)) {
			throw new HttpError(429, "rate_limited", { "retry-after": "60" });
		}
		const parsed = SessionBody.safeParse(await readJsonBody(req));
		if (!parsed.success) throw new HttpError(400, "invalid_request");
		const { nonce, sig } = parsed.data;

		if (device.publicKeyJwk) {
			if (nonce === undefined || sig === undefined) {
				// Step one: the nonce the device will sign.
				const issued = this.#nonces.issue(device.deviceId);
				sendJson(res, 200, { nonce: issued.token, expiresAt: issued.expiresAt });
				return;
			}
			const owner = this.#nonces.redeem(nonce);
			if (owner !== device.deviceId || !verifyDeviceProof(device.publicKeyJwk, nonce, sig)) {
				if (this.#unpaired.record()) this.#deps.onUnpairedAuth?.({ address: sourceAddress(req) });
				throw new HttpError(401, "unauthorized");
			}
		}
		const ticket = this.#tickets.issue({ deviceId: device.deviceId, ua: uaHash(req) });
		sendJson(res, 200, { ticket: ticket.token, expiresAt: ticket.expiresAt });
	}

	async #upload(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
		if (method !== "POST") throw new HttpError(405, "method not allowed");
		const device = this.#device(req);
		if (!device.grants.includes("workspace")) throw new HttpError(403, "forbidden");
		const stored = await this.#deps.uploads.receive(device.deviceId, req);
		sendJson(res, 200, { path: stored.path, name: stored.name, size: stored.size });
	}

	async #blob(req: IncomingMessage, res: ServerResponse, method: string, target: string): Promise<void> {
		if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
		const device = this.#device(req);
		if (!device.grants.includes("workspace")) throw new HttpError(403, "forbidden");
		await this.#deps.blobs.serve(device.deviceId, target, req, res);
	}

	/** The `Content-Security-Policy` of a page: this origin only, `connect-src` naming the WebSocket address. */
	#csp(): string {
		const { policy } = this.#deps;
		const socket = originOf(policy).replace(/^http/, "ws");
		return [
			"default-src 'self'",
			"script-src 'self'",
			"style-src 'self' 'unsafe-inline'",
			"font-src 'self' data:",
			"img-src 'self' data: blob:",
			"media-src 'self' blob:",
			`connect-src 'self' ${socket}`,
			"worker-src 'self' blob:",
			"manifest-src 'self'",
			"base-uri 'none'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		].join("; ");
	}

	async #static(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<void> {
		if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed", { allow: "GET, HEAD" });
		const root = this.#deps.staticRoot();
		const page = PAGE_ROUTES.has(pathname);
		const allowed = page || STATIC_FILES.has(pathname) || STATIC_DIRS.some(dir => pathname.startsWith(dir));
		if (!allowed) throw new HttpError(404, "not found");
		// `..`, backslashes, NULs and encoded separators never name a built file; refuse them outright.
		if (/\\|\0|%00|%2e|%2f|%5c/i.test(pathname) || pathname.includes("//") || pathname.split("/").includes("..")) {
			throw new HttpError(400, "bad path");
		}
		if (!root) throw new HttpError(404, "not found");
		const relative = page ? PAGE_FILE : pathname.slice(1);
		const file = await this.#resolveFile(root, relative);
		if (!file) throw new HttpError(404, "not found");

		const type = MIME[file.extension] ?? "application/octet-stream";
		const immutable = pathname.startsWith("/assets/");
		const headers: Record<string, string> = {
			"content-type": type,
			"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"x-frame-options": "DENY",
			"cross-origin-opener-policy": "same-origin",
			vary: "Accept-Encoding",
		};
		if (page) headers["content-security-policy"] = this.#csp();
		if (pathname === "/sw.js") headers["service-worker-allowed"] = "/";

		const wantsBrotli = /\bbr\b/.test(singleHeader(req.headers["accept-encoding"]) ?? "");
		if (wantsBrotli && COMPRESSIBLE.test(type) && file.size > 1024) {
			const body = await this.#brotliOf(file.path, file.size, file.mtimeMs);
			headers["content-encoding"] = "br";
			headers["content-length"] = String(body.length);
			res.writeHead(200, headers);
			res.end(method === "HEAD" ? undefined : body);
			return;
		}
		headers["content-length"] = String(file.size);
		res.writeHead(200, headers);
		if (method === "HEAD") {
			res.end();
			return;
		}
		res.end(await fsp.readFile(file.path));
	}

	/** A regular file inside `root` (symlinks resolved: one pointing out is refused), or null. */
	async #resolveFile(
		root: string,
		relative: string,
	): Promise<{ path: string; size: number; mtimeMs: number; extension: string } | null> {
		try {
			const realRoot = await fsp.realpath(root);
			const real = await fsp.realpath(path.join(root, relative));
			if (!real.startsWith(realRoot + path.sep)) return null;
			const info = await fsp.stat(real);
			if (!info.isFile()) return null;
			const dot = real.lastIndexOf(".");
			return { path: real, size: info.size, mtimeMs: info.mtimeMs, extension: dot === -1 ? "" : real.slice(dot) };
		} catch {
			return null;
		}
	}

	async #brotliOf(file: string, size: number, mtimeMs: number): Promise<Buffer> {
		const key = `${file}:${size}:${mtimeMs}`;
		const cached = this.#compressed.get(key);
		if (cached) return cached;
		const packed = await brotli(await fsp.readFile(file), {
			params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: size },
		});
		if (this.#compressedBytes + packed.length <= COMPRESSED_CACHE_MAX_BYTES) {
			this.#compressed.set(key, packed);
			this.#compressedBytes += packed.length;
		}
		return packed;
	}

	#upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const deny = (status: number): void => {
			socket.write(
				`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
			);
			socket.destroy();
		};
		const { servePrefix } = this.#deps.policy;
		const stripped = servePrefix === null ? null : stripServePrefix(req.url ?? "", servePrefix);
		if (stripped?.split("?", 1)[0] !== "/ws" || !isLoopbackAddress(req.socket.remoteAddress)) return deny(404);
		const checked = this.#check(req, "ws");
		if (!checked.ok) return deny(checked.status);

		const protocols = (singleHeader(req.headers["sec-websocket-protocol"]) ?? "").split(",").map(part => part.trim());
		const ticketToken = protocols.find(part => part.startsWith("ticket."))?.slice("ticket.".length);
		if (!protocols.includes(WS_PROTOCOL) || !ticketToken) return deny(400);
		// The page's previous connection (ws-router.ts `attach`): it may continue without loading its state again.
		const resumeFrom = protocols.find(part => part.startsWith("resume."))?.slice("resume.".length) || undefined;

		const { policy, devices, router } = this.#deps;
		const cookie = deviceCookieValue(req.headers, policy.secure);
		const auth = cookie === null ? null : devices.authenticate(cookie);
		const ticket = this.#tickets.redeem(ticketToken);
		if (!auth?.ok || !ticket || ticket.deviceId !== auth.device.deviceId || ticket.ua !== uaHash(req)) {
			if (this.#unpaired.record()) this.#deps.onUnpairedAuth?.({ address: sourceAddress(req) });
			return deny(401);
		}

		const deviceId = auth.device.deviceId;
		if (resumeFrom) router.retire(deviceId, resumeFrom);
		if (router.connectionCount(deviceId) >= 4) return deny(429);

		this.#wss.handleUpgrade(req, socket, head, ws => {
			const adapter: RouterSocket = {
				send: data => ws.send(data),
				close: (code, reason) => ws.close(code, reason),
				ping: () => ws.ping(),
				terminate: () => ws.terminate(),
				get bufferedAmount() {
					return ws.bufferedAmount;
				},
			};
			const connection = router.attach(deviceId, adapter, resumeFrom);
			if (!connection) {
				ws.close(1013, "too many connections");
				return;
			}
			ws.on("message", (data, isBinary) => {
				if (isBinary) connection.close(1003, "text frames only");
				else connection.receive(bufferOf(data).toString("utf8"));
			});
			ws.on("close", () => connection.dispose());
			ws.on("error", () => connection.dispose());
		});
	}
}
