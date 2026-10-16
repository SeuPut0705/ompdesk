/**
 * The mobile web server: HTTP and WebSocket on `127.0.0.1` only (`tailscale serve` publishes it to the tailnet
 * with HTTPS). Serves the built renderer from an allowlist, `/api/pair`, `/api/session` (a 30-second single-use
 * WebSocket ticket, after the device proves its key), `/ws`, `/blob/<token>` and `/upload`. Every request first
 * passes auth.ts's checks; every device call then needs the device's cookie. CORS headers are never sent.
 */
import { createHash, type JsonWebKey } from "node:crypto";
import { promises as fsp } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants } from "node:zlib";
import { type RawData, WebSocketServer } from "ws";
import { z } from "zod";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import { WEB_PUSH_CATEGORIES, type WebPushSettings, type WebPushStateResponse } from "../../shared/web-push";
import {
	checkRequest,
	clearedDeviceCookie,
	deviceCookieValue,
	isLoopbackAddress,
	OneTimeTokens,
	originOf,
	parsePublicKeyJwk,
	type RequestKind,
	type RequestPolicy,
	serializeDeviceCookie,
	TICKET_TTL_MS,
	tailscaleLogin,
	verifyDeviceProof,
} from "./auth";
import { BLOB_URL_PREFIX, type BlobStore } from "./blobs";
import { pushSettingsOf, type WebDevice, type WebDevices } from "./devices-store";
import type { PairingConfirmations, WebPairing } from "./pairing";
import { isPushEndpoint } from "./push";
import { PairingGuard, SlidingWindowLimiter, UnpairedThrottle } from "./rate-limit";
import { UploadError, type UploadStore } from "./uploads";
import { MAX_FRAME_BYTES, type RouterSocket, type WsRouter } from "./ws-router";

export const WEB_SERVER_HOST = "127.0.0.1";
const JSON_BODY_MAX_BYTES = 32 * 1024;
const SESSION_REQUESTS_PER_MINUTE = 20;
const PUSH_REQUESTS_PER_MINUTE = 20;
/** Compressed copies of static files kept in memory, in bytes. */
const COMPRESSED_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const WS_PROTOCOL = "ompdesk.v1";
/** How long stopping waits for sockets to finish their close handshake. */
const CLOSE_GRACE_MS = 1000;

const brotli = promisify(brotliCompress);

/** The renderer's built files a browser may be handed. */
const STATIC_DIRS = ["/assets/", "/cmaps/", "/standard_fonts/", "/wasm/", "/icons/"] as const;
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

const PairBody = z.object({
	code: z.string().min(1).max(64),
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
	pairing: WebPairing;
	confirmations: PairingConfirmations;
	/** Ask the desktop before a phone is paired (on by default; off only by the user's choice). */
	confirmPairing: () => boolean;
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
	requireIdentity?: boolean;
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
		this.#deps.pairing.clear();
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

	#check(req: IncomingMessage, kind: RequestKind): string | null {
		const result = checkRequest({
			headers: req.headers,
			method: req.method ?? "GET",
			kind,
			remoteAddress: req.socket.remoteAddress,
			policy: this.#deps.policy,
		});
		return result.ok ? null : result.reason;
	}

	async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const method = req.method ?? "GET";
		const target = req.url ?? "/";
		const queryAt = target.indexOf("?");
		const pathname = queryAt === -1 ? target : target.slice(0, queryAt);

		const isApi =
			pathname === "/api/pair" ||
			pathname === "/api/session" ||
			pathname === "/api/push" ||
			pathname === "/upload" ||
			pathname === "/healthz" ||
			pathname.startsWith(BLOB_URL_PREFIX);
		const refused = this.#check(req, isApi ? "api" : "page");
		if (refused) {
			sendStatus(res, refused === "wrong host" ? 421 : 403);
			return;
		}

		if (pathname === "/healthz") {
			if (method !== "GET") throw new HttpError(405, "method not allowed");
			sendJson(res, 200, { ok: true });
			return;
		}
		if (pathname === "/api/pair") return this.#pair(req, res, method);
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
		if (this.#unpaired.record()) this.#deps.onUnpairedAuth?.({ address: sourceAddress(req) });
		const headers: Record<string, string> = {};
		if (result && result.reason !== "malformed") headers["set-cookie"] = clearedDeviceCookie(policy.secure);

		throw new HttpError(401, "unauthorized", headers);
	}

	async #pair(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
		if (method !== "POST") throw new HttpError(405, "method not allowed");
		const { pairing, devices, confirmations, policy } = this.#deps;
		const address = sourceAddress(req);
		const decision = this.#pairGuard.check(address);
		if (!decision.ok) {
			throw new HttpError(429, "rate_limited", { "retry-after": String(Math.ceil(decision.retryAfterMs / 1000)) });
		}
		const parsed = PairBody.safeParse(await readJsonBody(req));
		if (!parsed.success) throw new HttpError(400, "invalid_request");
		const body = parsed.data;
		// An unissued code answers 404 for any input, so the endpoint tells nothing to someone guessing.
		const attempt = pairing.attempt(body.code);
		if (attempt === "inactive") throw new HttpError(404, "not_found");
		if (attempt === "wrong" || attempt === "locked") {
			this.#pairGuard.fail(address);
			throw new HttpError(403, attempt === "locked" ? "locked" : "wrong_code");
		}
		let publicKeyJwk: JsonWebKey | null = null;
		if (body.publicKeyJwk !== undefined && body.publicKeyJwk !== null) {
			publicKeyJwk = parsePublicKeyJwk(body.publicKeyJwk);
			if (!publicKeyJwk) throw new HttpError(400, "invalid_key");
		}
		const userAgent = singleHeader(req.headers["user-agent"]) ?? "";
		const login = tailscaleLogin(req.headers);
		let grants = [...DEFAULT_WEB_GRANTS];
		if (this.#deps.confirmPairing()) {
			const outcome = await confirmations.request({
				name: body.name.trim() || "Phone",
				userAgent,
				tailscaleLogin: login,
				ip: address,
			});
			if (!outcome.approved) throw new HttpError(403, outcome.reason);
			grants = outcome.grants;
		}
		this.#pairGuard.succeed(address);
		const { device, cookie } = devices.create({
			name: body.name,
			userAgent,
			tailscaleLogin: login,
			publicKeyJwk,
			grants,
		});
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
		const pathname = (req.url ?? "").split("?", 1)[0];
		if (pathname !== "/ws" || !isLoopbackAddress(req.socket.remoteAddress)) return deny(404);
		const refused = this.#check(req, "ws");
		if (refused) return deny(refused === "wrong host" ? 421 : 403);

		const protocols = (singleHeader(req.headers["sec-websocket-protocol"]) ?? "").split(",").map(part => part.trim());
		const ticketToken = protocols.find(part => part.startsWith("ticket."))?.slice("ticket.".length);
		if (!protocols.includes(WS_PROTOCOL) || !ticketToken) return deny(400);

		const { policy, devices, router } = this.#deps;
		const cookie = deviceCookieValue(req.headers, policy.secure);
		const auth = cookie === null ? null : devices.authenticate(cookie);
		const ticket = this.#tickets.redeem(ticketToken);
		if (!auth?.ok || !ticket || ticket.deviceId !== auth.device.deviceId || ticket.ua !== uaHash(req)) {
			if (this.#unpaired.record()) this.#deps.onUnpairedAuth?.({ address: sourceAddress(req) });
			return deny(401);
		}

		const deviceId = auth.device.deviceId;
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
			const connection = router.attach(deviceId, adapter);
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
