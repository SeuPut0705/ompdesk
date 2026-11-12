/**
 * The request matrix of the web edge (docs/rust-remaining-units.md §5.2): requests sent over a raw socket to the real
 * `WebServer` (its stores, limiters and `ws` are the real ones; only the router, uploads, blobs, hooks, whois and the
 * desktop are fakes) at a fixed clock and with fixed secrets, and what came back: status, every header in its order
 * (without `Date`, `Connection` and `Keep-Alive`, which Node writes per connection) and the body's SHA-256.
 *
 * The rows live in `native/ompdesk/crates/core/src/web/matrix.json` and are replayed by the core's Rust edge
 * (`web/matrix_replay.rs`), which must answer each one the same. This test checks the stored rows against the
 * TypeScript server, so a change to `server.ts` or `auth.ts` that moves an answer shows up here, and
 * `OMPDESK_WEB_MATRIX=write bunx vitest run --project main src/main/web/web-edge-matrix.test.ts` rewrites the file (and
 * the static fixtures under `web/testdata/static`) from the server as it is.
 *
 * Coverage: every value of each dimension against every value of each other dimension at least once (pairwise,
 * greedy and deterministic), the order the walls are checked in (every pair of failing walls), the rate limits and
 * the key-proof session as sequences, webhooks and the WebSocket upgrade's refusals.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { brotliCompressSync, constants as zlib } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import { WebBlocks } from "./blocks-store";
import { WebDevices } from "./devices-store";
import { PairingConfirmations } from "./pairing";
import { WebServer } from "./server";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const WRONG = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const HOOK_KEY = "hook-key";
const PUSH_KEY = `B${"p".repeat(86)}`;
const PHONE = "100.64.0.9";
const BLOCKED_PHONE = "100.64.0.66";
const IMPOSTOR = "100.64.0.77";
const ALLOWED = ["me@example.com", "blocked@example.com"];
const DEVICE_KEY = {
	kty: "EC",
	x: "-sTD7v2PYgsYen9Dmja0_iP1dghnXCG6dtyqqOw8jcc",
	y: "svnRBh7RW7JM-eSxHYdh9vQQiwVyCFSFKh3bQE8earM",
	crv: "P-256",
	d: "EoNL-9anV618Ln5ttwpUNisTX4WOeckQpy047SYC_qk",
};
const SECRETS: Record<string, string> = {
	devkey: "ZRQMLvoJ4TuXKIkxDyuBmIChY4d2OGizy4p3mMVd010",
	devnokey: "qwQPhF9CwERk32h-OdNXsw1Az8mR0Ip358CDHjCeIn8",
	devnowork: "JiPYqBhPvEwGxe-AbUEkL7Xa61FAtapOrbOkINLvomM",
	devsliding: "O548b4dDwAaPZqytwcjX30W5SztvjzTapSISPMMd4M4",
	devabsolute: "pnbn61HuJp-BjWdSUqjUxGGtqqssrvqL-s1ir8TnesI",
	devrevoked: "QEFz5bc5e5BtguPzV1gzeKkeLDCMTIUAF1uhgLYsQ8o",
};

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const CORE_WEB = resolve(HERE, "../../../native/ompdesk/crates/core/src/web");
const MATRIX_FILE = join(CORE_WEB, "matrix.json");
const STATIC_DIR = join(CORE_WEB, "testdata", "static");
const WRITE = process.env.OMPDESK_WEB_MATRIX === "write";

type Header = [string, string];
interface Policy {
	host: string;
	publicPort: number;
	secure: boolean;
	servePrefix: string | null;
	pendingPrefix: string | null;
}
interface Request {
	method: string;
	target: string;
	headers: Header[];
	body: string | null;
	/** A text template: `{nonce}` is the last answer's nonce, `{sig}` its signature by the fixture key. */
	templated?: boolean;
	/** Count the request this many times in a row (rate limits): only the last answer is kept. */
	repeat?: number;
	/** `{ip}` in a header is replaced by `10.0.<n>.1`. */
	distinctIp?: boolean;
}
interface Answer {
	status: number;
	reason: string;
	headers: Header[];
	bodyLen: number;
	bodySha256: string;
}
interface Row {
	id: string;
	policy: Policy;
	blocks: boolean;
	confirm: "approve" | "decline" | null;
	noRoot?: boolean;
	requests: Request[];
	answers: Answer[];
	effects: { unpaired: number; connected: number; hooks: string[][]; uploads: string[]; blobs: string[] };
}

const POLICIES = {
	serve: { host: "phone.tail1234.ts.net", publicPort: 443, secure: true },
	"serve-port": { host: "phone.tail1234.ts.net", publicPort: 47831, secure: true },
	plain: { host: "127.0.0.1", publicPort: 8123, secure: false },
} as const;
type PolicyName = keyof typeof POLICIES;
type State = "published" | "pending" | "unpublished";

function policyOf(name: PolicyName, state: State): Policy {
	return {
		...POLICIES[name],
		servePrefix: state === "published" ? SECRET : null,
		pendingPrefix: state === "pending" ? SECRET : null,
	};
}

const hostOf = (p: Policy): string => (p.publicPort === (p.secure ? 443 : 80) ? p.host : `${p.host}:${p.publicPort}`);
const originOf = (p: Policy): string => `${p.secure ? "https" : "http"}://${hostOf(p)}`;

function cookieOf(id: string, secure: boolean): string {
	const name = secure ? "__Host-ompdesk" : "ompdesk";
	return `${name}=${id}.${SECRETS[id] ?? "x"}`;
}

/** The static folder's files, made the same way each time: the fixture folder is the source. */
function writeStaticFixtures(): void {
	rmSync(STATIC_DIR, { recursive: true, force: true });
	for (const dir of ["assets", "icons", "cmaps"]) mkdirSync(join(STATIC_DIR, dir), { recursive: true });
	mkdirSync(join(STATIC_DIR, "prev", "assets"), { recursive: true });
	const page = `<!doctype html><title>OMPdesk</title>${"<p>phone page</p>".repeat(90)}\n`;
	const script = `${"console.log('x');".repeat(200)}\n`;
	writeFileSync(join(STATIC_DIR, "web.html"), page);
	writeFileSync(join(STATIC_DIR, "assets", "app-abc.js"), script);
	writeFileSync(join(STATIC_DIR, "assets", "app-built.js"), `${"export const built = 1;".repeat(120)}\n`);
	writeFileSync(join(STATIC_DIR, "assets", "app-stale.js"), `${"export const stale = 2;".repeat(120)}\n`);
	writeFileSync(join(STATIC_DIR, "assets", "small.css"), "a{color:red}\n");
	writeFileSync(join(STATIC_DIR, "assets", "data.map"), `{"version":3,"mappings":"${"AAAA,".repeat(400)}"}\n`);
	writeFileSync(
		join(STATIC_DIR, "assets", "font.woff2"),
		Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7) & 255)),
	);
	writeFileSync(join(STATIC_DIR, "assets", "noext"), "no extension\n");
	writeFileSync(join(STATIC_DIR, "cmaps", "x.bcmap"), Buffer.from("bcmap bytes\n"));
	writeFileSync(
		join(STATIC_DIR, "icons", "icon.png"),
		Buffer.from(Array.from({ length: 900 }, (_, i) => (i * 13) & 255)),
	);
	writeFileSync(join(STATIC_DIR, "sw.js"), "self.addEventListener('install',()=>{});\n");
	writeFileSync(join(STATIC_DIR, "manifest.webmanifest"), '{"name":"OMPdesk"}\n');
	writeFileSync(join(STATIC_DIR, "pre-paint.js"), `${"document.x=1;".repeat(100)}\n`);
	writeFileSync(join(STATIC_DIR, "favicon.ico"), Buffer.from("ico\n"));
	writeFileSync(join(STATIC_DIR, "secret.txt"), "private\n");
	writeFileSync(join(STATIC_DIR, "prev", "assets", "app-old.js"), `${"console.log('old');".repeat(150)}\n`);
	// The build's own copies (quality 11): one current, one older than its file (it is ignored).
	for (const name of ["app-built.js", "app-stale.js"]) {
		const file = readFileSync(join(STATIC_DIR, "assets", name));
		writeFileSync(
			join(STATIC_DIR, "assets", `${name}.br`),
			brotliCompressSync(file, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11 } }),
		);
	}
	// The built `.br` of a file which does not exist beside it, and a replaced build's file with its own.
	writeFileSync(join(STATIC_DIR, "assets", "orphan.js.br"), Buffer.from("not a file of its own\n"));
}

/** mtimes the fixtures need and git does not keep: `.br` newer than its file, or older (a stale one). */
function setStaticTimes(root: string): void {
	const old = new Date(NOW - 10 * DAY);
	const recent = new Date(NOW - DAY);
	const stale = new Date(NOW - 20 * DAY);
	for (const name of ["app-built.js", "app-stale.js"]) utimesSync(join(root, "assets", name), old, old);
	utimesSync(join(root, "assets", "app-built.js.br"), recent, recent);
	utimesSync(join(root, "assets", "app-stale.js.br"), stale, stale);
}

function devicesDocument(): unknown {
	const grants = [...DEFAULT_WEB_GRANTS];
	const device = (id: string, over: Record<string, unknown> = {}) => ({
		deviceId: id,
		name: id,
		userAgent: "Seeded/1.0",
		tailscaleLogin: "me@example.com",
		nodeId: "nPHONE1",
		secretSha256: createHash("sha256")
			.update(SECRETS[id] ?? "")
			.digest("hex"),
		publicKeyJwk: null,
		grants,
		uiPrefs: {},
		createdAt: NOW - 3 * DAY,
		lastSeenAt: NOW - 120_000,
		...over,
	});
	const pub = { kty: "EC", crv: "P-256", x: DEVICE_KEY.x, y: DEVICE_KEY.y };
	return {
		v: 1,
		devices: [
			device("devkey", { publicKeyJwk: pub }),
			device("devnokey"),
			device("devnowork", { grants: grants.filter(g => g !== "workspace" && g !== "device-self") }),
			device("devsliding", { lastSeenAt: NOW - 15 * DAY }),
			device("devabsolute", { createdAt: NOW - 91 * DAY }),
		],
	};
}

function blockedDocument(): unknown {
	const entry = (id: string, scope: string, login: string | null) => ({
		id,
		scope,
		name: id,
		tailscaleLogin: login,
		blockedAt: NOW - DAY,
	});
	return {
		v: 1,
		blocked: [
			entry("node:nBLOCKED", "node", "me@example.com"),
			entry("login:blocked@example.com", "login", "blocked@example.com"),
		],
	};
}

function seedDevices(userData: string, blocks: boolean): void {
	writeFileSync(join(userData, "web-devices.json"), JSON.stringify(devicesDocument()));
	if (blocks) writeFileSync(join(userData, "web-blocked.json"), JSON.stringify(blockedDocument()));
}

interface Raw {
	status: number;
	reason: string;
	headers: Header[];
	body: Buffer;
}

function dechunk(data: Buffer): Buffer {
	const parts: Buffer[] = [];
	let at = 0;
	for (;;) {
		const eol = data.indexOf("\r\n", at);
		const size = Number.parseInt(data.subarray(at, eol).toString(), 16);
		if (size === 0) return Buffer.concat(parts);
		parts.push(data.subarray(eol + 2, eol + 2 + size));
		at = eol + 2 + size + 2;
	}
}

/**
 * A server that answers a body it will not read (413) and closes sends the client a reset, which on some stacks (macOS CI,
 * sometimes Windows) discards the answer still unread in the client's buffer. Only those rows can see it (a body over the
 * 32 KiB the routes read), they are single answers with no side effect the answer depends on, so one that met a reset
 * before any response head is asked again.
 */
async function send(port: number, request: Request, extra: Header[]): Promise<Raw> {
	const large = request.body !== null && request.body.length >= 30_000;
	for (let attempt = 1; ; attempt++) {
		try {
			return await sendOnce(port, request, extra);
		} catch (error) {
			if (!large || attempt >= 5) throw error;
		}
	}
}

function sendOnce(port: number, request: Request, extra: Header[]): Promise<Raw> {
	return new Promise((resolveRaw, reject) => {
		const body = request.body === null ? null : Buffer.from(request.body);
		const headers = [...request.headers, ...extra];
		if (body !== null) headers.push(["content-length", String(body.length)]);
		headers.push(["connection", "close"]);
		const head = `${request.method} ${request.target} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
		const socket = net.connect(port, "127.0.0.1");
		const chunks: Buffer[] = [];
		socket.on("data", chunk => chunks.push(chunk));
		// The server may answer and close before it has read a large body; the reset that follows ends the exchange. A
		// reset before any response head arrived is still a failure.
		let failure: Error | null = null;
		socket.on("error", error => {
			failure = error;
		});
		socket.on("close", () => {
			const data = Buffer.concat(chunks);
			const end = data.indexOf("\r\n\r\n");
			if (end === -1) return reject(failure ?? new Error(`no response: ${data.toString()}`));
			const lines = data.subarray(0, end).toString("latin1").split("\r\n");
			const [, status, ...reason] = (lines[0] ?? "").split(" ");
			const parsed: Header[] = lines.slice(1).map(line => {
				const at = line.indexOf(":");
				return [line.slice(0, at), line.slice(at + 1).trim()];
			});
			let rest: Buffer = data.subarray(end + 4);
			const chunked = parsed.some(([k, v]) => k.toLowerCase() === "transfer-encoding" && /chunked/i.test(v));
			if (request.method === "HEAD") rest = Buffer.alloc(0);
			else if (chunked) rest = dechunk(rest);
			const declared = parsed.find(([k]) => k.toLowerCase() === "content-length")?.[1];
			if (failure && declared !== undefined && rest.length < Number(declared)) return reject(failure);
			resolveRaw({ status: Number(status), reason: reason.join(" "), headers: parsed, body: rest });
		});
		socket.write(head);
		if (body) socket.write(body);
	});
}

const HOP = new Set(["date", "connection", "keep-alive"]);

/** What varies per run in an answer (random tokens and ids) is replaced before the body is hashed. */
function normalize(raw: Raw): Answer {
	const headers: Header[] = raw.headers
		.filter(([k]) => !HOP.has(k.toLowerCase()))
		.map(([k, v]) =>
			k.toLowerCase() === "set-cookie" ? [k, v.replace(/^(__Host-ompdesk|ompdesk)=[^;]+;/, "$1=<cookie>;")] : [k, v],
		);
	let text = raw.body;
	if (/json/.test(headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "")) {
		text = Buffer.from(
			raw.body
				.toString()
				// `OneTimeTokens` reads the real clock (`Date.now`), not the server's `now`: its `expiresAt` is blanked too.
				.replace(/"(nonce|ticket|deviceId)":"[^"]*"/g, '"$1":"<token>"')
				.replace(/"expiresAt":\d+/g, '"expiresAt":0'),
		);
	}
	return {
		status: raw.status,
		reason: raw.reason,
		headers,
		bodyLen: text.length,
		bodySha256: createHash("sha256").update(text).digest("hex"),
	};
}

function signNonce(nonce: string): string {
	const key = createPrivateKey({ key: DEVICE_KEY, format: "jwk" });
	return sign("sha256", Buffer.from(nonce), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

let rowSeq = 0;

async function runRow(
	spec: Omit<Row, "answers" | "effects" | "id"> & { id?: string },
	staticRoot: string,
): Promise<Row> {
	const userData = mkdtempSync(join(tmpdir(), "web-matrix-"));
	seedDevices(userData, spec.blocks);
	const effects: Row["effects"] = { unpaired: 0, connected: 0, hooks: [], uploads: [], blobs: [] };
	const policy = { ...spec.policy, allowedUsers: () => ALLOWED };
	let confirmations: PairingConfirmations;
	const respondTo = (id: string) =>
		queueMicrotask(() => confirmations.respond({ id, approve: spec.confirm === "approve" }));
	confirmations = new PairingConfirmations({ notify: request => respondTo(request.id), now: () => NOW });
	const devices = new WebDevices(userData, () => NOW);
	const peers: Record<string, { nodeId: string | null; nodeName: string | null; login: string | null }> = {
		[PHONE]: { nodeId: "nPHONE1", nodeName: "s25u", login: "me@example.com" },
		[BLOCKED_PHONE]: { nodeId: "nBLOCKED", nodeName: "bad-phone", login: "me@example.com" },
		[IMPOSTOR]: { nodeId: "nOTHER", nodeName: "other", login: "someone@else.example" },
	};
	const server = new WebServer({
		policy,
		devices,
		blocks: new WebBlocks(userData, () => NOW),
		confirmations,
		confirmNewDevices: () => spec.confirm !== null,
		whois: async address => peers[address] ?? null,
		onDeviceConnected: () => {
			effects.connected++;
		},
		router: { connectionCount: () => 0, retire: () => {}, attach: () => null, closeAll: () => {} } as never,
		uploads: {
			receive: async (deviceId: string, req: AsyncIterable<Buffer>) => {
				let size = 0;
				for await (const chunk of req) size += chunk.length;
				effects.uploads.push(`${deviceId}:${size}`);
				return { path: "/up/x.bin", name: "x.bin", size };
			},
		} as never,
		blobs: {
			serve: async (
				deviceId: string,
				target: string,
				_req: unknown,
				res: { writeHead(s: number, h: Record<string, string>): void; end(b: string): void },
			) => {
				effects.blobs.push(`${deviceId}:${target}`);
				const body = `blob:${deviceId}:${target}`;
				res.writeHead(200, {
					"content-type": "application/octet-stream",
					"content-length": String(Buffer.byteLength(body)),
				});
				res.end(body);
			},
		} as never,
		staticRoot: () => (spec.noRoot ? null : staticRoot),
		previousBuilds: () => [join(staticRoot, "prev")],
		onUnpairedAuth: () => {
			effects.unpaired++;
		},
		push: { publicKey: () => PUSH_KEY },
		hooks: () => ({
			webhook: async (id: string, bearer: string, detail: string) => {
				effects.hooks.push([id, bearer, detail]);
				return ({ fire: "fired", deny: "denied", off: "off" } as const)[id as "fire"] ?? "unknown";
			},
		}),
		now: () => NOW,
	});
	const { port } = await server.start({ port: 0 });
	const answers: Answer[] = [];
	try {
		let last = "";
		let n = 0;
		for (const request of spec.requests) {
			const times = request.repeat ?? 1;
			for (let i = 0; i < times; i++) {
				n++;
				let { body } = request;
				if (request.templated && body !== null) {
					const nonce = /"nonce":"([^"]*)"/.exec(last)?.[1] ?? "";
					body = body.replace("{nonce}", nonce).replace("{sig}", signNonce(nonce));
				}
				const headers: Header[] = request.headers.map(([k, v]) => [
					k,
					request.distinctIp && k === "x-forwarded-for" ? `10.0.${n}.1` : v.replace("{port}", String(port)),
				]);
				const raw = await send(
					port,
					{ ...request, target: request.target.replace("{port}", String(port)), headers, body },
					[],
				);
				last = raw.body.toString();
				if (i === times - 1) answers.push(normalize(raw));
			}
		}
	} finally {
		await server.stop();
		rmSync(userData, { recursive: true, force: true });
	}
	return { id: spec.id ?? `r${String(++rowSeq).padStart(3, "0")}`, ...spec, answers, effects } as Row;
}

// ---------------------------------------------------------------------------------------------------- the rows

/** A request as the dimensions build it: before the prefix and the per-policy values are applied. */
interface Spec {
	method: string;
	path: string;
	headers: Map<string, string>;
	body: string | null;
	policy: PolicyName;
	state: State;
	prefix: string;
	blocks: boolean;
	cookie: string | null;
	confirm: Row["confirm"];
}

type Apply = (spec: Spec) => void;
type Dimension = [string, [string, Apply][]];

const set =
	(name: string, value: string | null): Apply =>
	spec => {
		if (value === null) spec.headers.delete(name);
		else spec.headers.set(name, value);
	};
const path =
	(method: string, p: string, body: string | null = null): Apply =>
	spec => {
		spec.method = method;
		spec.path = p;
		spec.body = body;
		if (body !== null) {
			spec.headers.set("content-type", "application/json");
			spec.headers.set("user-agent", "TestBrowser/1.0");
		}
	};

const dimensions = (): Dimension[] => [
	[
		"req",
		[
			["asset", path("GET", "/assets/app-abc.js")],
			["asset-head", path("HEAD", "/assets/app-abc.js")],
			["asset-built-br", path("GET", "/assets/app-built.js")],
			["asset-stale-br", path("GET", "/assets/app-stale.js")],
			["asset-small", path("GET", "/assets/small.css")],
			["asset-woff2", path("GET", "/assets/font.woff2")],
			["asset-prev", path("GET", "/assets/app-old.js")],
			["asset-missing", path("GET", "/assets/missing.js")],
			["asset-post", path("POST", "/assets/app-abc.js", "{}")],
			["index", path("GET", "/")],
			["index-head", path("HEAD", "/")],
			["pair-page", path("GET", "/pair?x=1")],
			["sw", path("GET", "/sw.js")],
			["manifest", path("GET", "/manifest.webmanifest")],
			["icon", path("GET", "/icons/icon.png")],
			["dotdot", path("GET", "/assets/../secret.txt")],
			["encoded-dot", path("GET", "/assets/%2e%2e/secret.txt")],
			["secret-file", path("GET", "/secret.txt")],
			["unknown", path("GET", "/nope")],
			["unknown-put", path("PUT", "/nope", "{}")],
			["healthz", path("GET", "/healthz")],
			["healthz-post", path("POST", "/healthz", "{}")],
			["session-first", path("POST", "/api/session", "{}")],
			["session-get", path("GET", "/api/session")],
			["session-bad-nonce", path("POST", "/api/session", '{"nonce":"nope","sig":"AAAA"}')],
			["session-bad-json", path("POST", "/api/session", "{")],
			["pair", path("POST", "/api/pair", '{"name":"My phone"}')],
			[
				"pair-key",
				path(
					"POST",
					"/api/pair",
					`{"name":"k","publicKeyJwk":${JSON.stringify({ kty: "EC", crv: "P-256", x: DEVICE_KEY.x, y: DEVICE_KEY.y })}}`,
				),
			],
			["pair-bad-key", path("POST", "/api/pair", '{"publicKeyJwk":{"kty":"RSA"}}')],
			["pair-get", path("GET", "/api/pair")],
			["push-get", path("GET", "/api/push")],
			["push-post", path("POST", "/api/push", '{"hideContent":true,"categories":["ask","error"]}')],
			[
				"push-bad-endpoint",
				path(
					"POST",
					"/api/push",
					`{"subscription":{"endpoint":"https://127.0.0.1/x","keys":{"p256dh":"${"a".repeat(87)}","auth":"${"b".repeat(22)}"}}}`,
				),
			],
			["upload", path("POST", "/upload", "abc")],
			["upload-get", path("GET", "/upload")],
			["blob", path("GET", "/blob/tok123?x=1")],
			["blob-post", path("POST", "/blob/tok123", "{}")],
			["api-unknown", path("GET", "/api/other")],
			["hook", path("POST", "/hooks/fire", "{}")],
			["options", path("OPTIONS", "/api/session")],
			["delete", path("DELETE", "/assets/app-abc.js")],
		],
	],
	[
		"state",
		[
			["published", s => (s.state = "published")],
			["pending", s => (s.state = "pending")],
			["unpublished", s => (s.state = "unpublished")],
		],
	],
	[
		"prefix",
		[
			["right", s => (s.prefix = SECRET)],
			["wrong", s => (s.prefix = WRONG)],
			["absent", s => (s.prefix = "")],
			["short", s => (s.prefix = SECRET.slice(0, -1))],
			["long", s => (s.prefix = `${SECRET}x`)],
			["double", s => (s.prefix = `${SECRET}/${SECRET}`)],
		],
	],
	[
		"policy",
		[
			["serve", s => (s.policy = "serve")],
			["serve-port", s => (s.policy = "serve-port")],
			["plain", s => (s.policy = "plain")],
		],
	],
	[
		"host",
		[
			["right", set("host", "{host}")],
			["wrong", set("host", "evil.example")],
			["upper", set("host", "{HOST}")],
			["wrong-port", set("host", "{host}:1")],
			["loopback", set("host", "127.0.0.1:{port}")],
		],
	],
	[
		"origin",
		[
			["right", set("origin", "{origin}")],
			["absent", set("origin", null)],
			["wrong", set("origin", "https://evil.example")],
			["upper", set("origin", "{ORIGIN}")],
			["null", set("origin", "null")],
			["wrong-scheme", set("origin", "ftp://{host}")],
		],
	],
	[
		"site",
		[
			["absent", set("sec-fetch-site", null)],
			["same-origin", set("sec-fetch-site", "same-origin")],
			["none", set("sec-fetch-site", "none")],
			["cross-site", set("sec-fetch-site", "cross-site")],
			["same-site", set("sec-fetch-site", "same-site")],
			[
				"cross-nav",
				spec => {
					spec.headers.set("sec-fetch-site", "cross-site");
					spec.headers.set("sec-fetch-mode", "navigate");
				},
			],
		],
	],
	[
		"login",
		[
			["allowed", set("tailscale-user-login", "me@example.com")],
			["absent", set("tailscale-user-login", null)],
			["case", set("tailscale-user-login", "ME@Example.COM")],
			["mime", set("tailscale-user-login", "=?utf-8?q?me=40example.com?=")],
			["denied", set("tailscale-user-login", "other@example.com")],
			["empty", set("tailscale-user-login", "  ")],
			["blocked-login", set("tailscale-user-login", "blocked@example.com")],
		],
	],
	[
		"xff",
		[
			["phone", set("x-forwarded-for", PHONE)],
			["none", set("x-forwarded-for", null)],
			["blocked", set("x-forwarded-for", BLOCKED_PHONE)],
			["impostor", set("x-forwarded-for", IMPOSTOR)],
			["junk", set("x-forwarded-for", "not-an-ip")],
			["chain", set("x-forwarded-for", `${PHONE}, 1.2.3.4`)],
		],
	],
	[
		"blocks",
		[
			["none", s => (s.blocks = false)],
			["active", s => (s.blocks = true)],
		],
	],
	[
		"cookie",
		[
			["none", s => (s.cookie = null)],
			["valid", s => (s.cookie = "devkey")],
			["nokey", s => (s.cookie = "devnokey")],
			["nowork", s => (s.cookie = "devnowork")],
			["sliding", s => (s.cookie = "devsliding")],
			["absolute", s => (s.cookie = "devabsolute")],
			["revoked", s => (s.cookie = "devrevoked")],
			["wrong-secret", s => (s.cookie = "wrongsecret")],
			["malformed", s => (s.cookie = "malformed")],
			["empty", s => (s.cookie = "empty")],
			["other-name", s => (s.cookie = "othername")],
		],
	],
	[
		"funnel",
		[
			["absent", set("tailscale-funnel-request", null)],
			["present", set("tailscale-funnel-request", "?1")],
		],
	],
	[
		"encoding",
		[
			["none", set("accept-encoding", null)],
			["br", set("accept-encoding", "gzip, deflate, br")],
			["gzip", set("accept-encoding", "gzip")],
			["br-q0", set("accept-encoding", "br;q=0")],
		],
	],
	[
		"language",
		[
			["none", set("accept-language", null)],
			["en", set("accept-language", "en-US,en;q=0.9")],
			["ko", set("accept-language", "ko-KR,ko;q=0.9")],
			["ko-late", set("accept-language", "en,ko")],
		],
	],
];

function baseline(): Spec {
	return {
		method: "GET",
		path: "/assets/app-abc.js",
		headers: new Map<string, string>(),
		body: null,
		policy: "serve",
		state: "published",
		prefix: SECRET,
		blocks: false,
		cookie: null,
		confirm: null,
	};
}

/** The dimension values chosen for a row, applied in the dimensions' order over the baseline. */
function build(choice: Record<string, string>): Row | null {
	const spec = baseline();
	const table = dimensions();
	// Policy first: host/origin values refer to it.
	for (const [name, values] of table) {
		const apply = values.find(([value]) => value === choice[name])?.[1];
		if (!apply) throw new Error(`no value ${choice[name]} for ${name}`);
		apply(spec);
	}
	return spec as never;
}

function finish(spec: Spec, choice: Record<string, string>): Omit<Row, "answers" | "effects" | "id"> & { id: string } {
	const policy = policyOf(spec.policy, spec.state);
	const lower = (value: string) => value.toLowerCase();
	const fill = (value: string) =>
		value
			.replace("{host}", hostOf(policy))
			.replace("{HOST}", hostOf(policy).toUpperCase())
			.replace("{origin}", originOf(policy))
			.replace("{ORIGIN}", originOf(policy).toUpperCase());
	const headers: Header[] = [];
	// Host first, as a client writes it; the others in the dimensions' order.
	const host = spec.headers.get("host");
	headers.push(["host", fill(host ?? "{host}")]);
	for (const [name, value] of spec.headers) if (name !== "host") headers.push([name, fill(value)]);
	if (spec.cookie !== null) {
		const secure = policy.secure;
		const cookieName = secure ? "__Host-ompdesk" : "ompdesk";
		const value =
			spec.cookie === "wrongsecret"
				? `${cookieName}=devkey.${WRONG}`
				: spec.cookie === "malformed"
					? `${cookieName}=nodot`
					: spec.cookie === "empty"
						? `${cookieName}=`
						: spec.cookie === "othername"
							? `other=${"devkey"}.${SECRETS.devkey}`
							: cookieOf(spec.cookie, secure);
		headers.push(["cookie", value]);
	}
	void lower;
	const target = `${spec.prefix === "" ? "" : `/${spec.prefix}`}${spec.path}`;
	return {
		id: Object.values(choice).join("|"),
		policy,
		blocks: spec.blocks,
		confirm: spec.confirm,
		requests: [{ method: spec.method, target, headers, body: spec.body }],
	};
}

/** Greedy pairwise cover: every pair of values of two dimensions in at least one row; deterministic. */
function pairwise(table: Dimension[]): Record<string, string>[] {
	const names = table.map(([name]) => name);
	const values = table.map(([, v]) => v.map(([name]) => name));
	const uncovered = new Set<string>();
	for (let a = 0; a < names.length; a++)
		for (let b = a + 1; b < names.length; b++)
			for (const x of values[a] ?? []) for (const y of values[b] ?? []) uncovered.add(`${a}:${x}|${b}:${y}`);
	const rows: Record<string, string>[] = [];
	// A tiny deterministic generator for tie-breaks.
	let seed = 12345;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed;
	};
	while (uncovered.size > 0) {
		const first = [...uncovered][0] as string;
		const [pa, pb] = first.split("|") as [string, string];
		const row: (string | undefined)[] = new Array(names.length).fill(undefined);
		const [ai, av] = pa.split(":") as [string, string];
		const [bi, bv] = pb.split(":") as [string, string];
		row[Number(ai)] = av;
		row[Number(bi)] = bv;
		const order = names.map((_, i) => i).filter(i => row[i] === undefined);
		for (let k = order.length - 1; k > 0; k--) {
			const j = rnd() % (k + 1);
			[order[k], order[j]] = [order[j] as number, order[k] as number];
		}
		for (const i of order) {
			let best = values[i]?.[0] as string;
			let bestGain = -1;
			for (const candidate of values[i] ?? []) {
				let gain = 0;
				for (let j = 0; j < names.length; j++) {
					const other = row[j];
					if (j === i || other === undefined) continue;
					const key = i < j ? `${i}:${candidate}|${j}:${other}` : `${j}:${other}|${i}:${candidate}`;
					if (uncovered.has(key)) gain++;
				}
				if (gain > bestGain) {
					bestGain = gain;
					best = candidate;
				}
			}
			row[i] = best;
		}
		const choice: Record<string, string> = {};
		names.forEach((name, i) => {
			choice[name] = row[i] as string;
		});
		for (let a = 0; a < names.length; a++)
			for (let b = a + 1; b < names.length; b++) uncovered.delete(`${a}:${row[a]}|${b}:${row[b]}`);
		rows.push(choice);
	}
	return rows;
}

const FIRST: Record<string, string> = {};
for (const [name, values] of dimensions()) FIRST[name] = values[0]?.[0] as string;
/** The request every wall passes, from a device that exists. */
const GOOD: Record<string, string> = {
	...FIRST,
	req: "asset",
	state: "published",
	prefix: "right",
	policy: "serve",
	host: "right",
	origin: "right",
	site: "same-origin",
	login: "allowed",
	xff: "phone",
	blocks: "none",
	cookie: "none",
	funnel: "absent",
	encoding: "none",
	language: "none",
};
/** Each wall's failing value on a request that otherwise passes, in the order `checkRequest` runs them. */
const WALLS: [string, string][] = [
	["funnel", "present"],
	["prefix", "absent"],
	["host", "wrong"],
	["origin", "wrong"],
	["site", "cross-site"],
	["login", "absent"],
	["login", "denied"],
];

function precedenceChoices(): Record<string, string>[] {
	const out: Record<string, string>[] = [];
	for (const req of ["asset", "index", "pair", "session-first"]) {
		for (let a = 0; a < WALLS.length; a++) {
			for (let b = a + 1; b < WALLS.length; b++) {
				const [da, va] = WALLS[a] as [string, string];
				const [db, vb] = WALLS[b] as [string, string];
				if (da === db) continue;
				out.push({ ...GOOD, req: req === "pair" ? "pair" : req, [da]: va, [db]: vb });
			}
		}
	}
	// Both prefix states with the bad prefix, and every wall alone.
	for (const [d, v] of WALLS) out.push({ ...GOOD, [d]: v });
	return out;
}

const post = (target: string, body: string, headers: Header[] = [], origin = "{origin}"): Request => ({
	method: "POST",
	target: `/${SECRET}${target}`,
	headers: [
		["host", "{host}"],
		["origin", origin],
		["sec-fetch-site", "same-origin"],
		["tailscale-user-login", "me@example.com"],
		["x-forwarded-for", PHONE],
		["content-type", "application/json"],
		["user-agent", "TestBrowser/1.0"],
		...headers,
	],
	body,
});

function sequences(): Omit<Row, "answers" | "effects">[] {
	const p = policyOf("serve", "published");
	const fill = (r: Request): Request => ({
		...r,
		headers: r.headers.map(([k, v]) => [k, v.replace("{host}", hostOf(p)).replace("{origin}", originOf(p))]),
	});
	const cookie = (id: string): Header => ["cookie", cookieOf(id, true)];
	const rows: Omit<Row, "answers" | "effects">[] = [];
	const add = (id: string, requests: Request[], over: Partial<Row> = {}) =>
		rows.push({ id, policy: p, blocks: false, confirm: null, requests: requests.map(fill), ...over });

	// The key proof: the nonce, a good signature, the same nonce again (spent), another device's nonce.
	add("seq-session-proof", [
		post("/api/session", "{}", [cookie("devkey")]),
		{ ...post("/api/session", '{"nonce":"{nonce}","sig":"{sig}"}', [cookie("devkey")]), templated: true },
		{ ...post("/api/session", '{"nonce":"{nonce}","sig":"{sig}"}', [cookie("devkey")]), templated: true },
	]);
	add("seq-session-bad-sig", [
		post("/api/session", "{}", [cookie("devkey")]),
		{ ...post("/api/session", '{"nonce":"{nonce}","sig":"AAAA"}', [cookie("devkey")]), templated: true },
		{ ...post("/api/session", '{"nonce":"{nonce}","sig":"{sig}"}', [cookie("devkey")]), templated: true },
	]);
	add("seq-session-nokey", [post("/api/session", "{}", [cookie("devnokey")])]);
	add("seq-session-limit", [{ ...post("/api/session", "{}", [cookie("devnokey")]), repeat: 21 }]);
	add("seq-session-limit-other-device", [
		{ ...post("/api/session", "{}", [cookie("devnokey")]), repeat: 20 },
		post("/api/session", "{}", [cookie("devkey")]),
	]);
	add("seq-push-limit", [{ ...post("/api/push", "{}", [cookie("devnokey")]), repeat: 21 }]);
	add("seq-pair-limit-address", [{ ...post("/api/pair", '{"name":"x"}'), repeat: 11 }]);
	add("seq-pair-limit-enroll", [{ ...post("/api/pair", '{"name":"x"}'), repeat: 21, distinctIp: true }]);
	add("seq-pair-then-session", [post("/api/pair", '{"name":"x"}')]);
	add("seq-pair-approve", [post("/api/pair", '{"name":"x"}')], { confirm: "approve" });
	add("seq-pair-decline", [post("/api/pair", '{"name":"x"}'), post("/api/pair", '{"name":"x"}')], {
		confirm: "decline",
	});
	add("seq-pair-mismatch", [post("/api/pair", '{"name":"x"}', [["x-forwarded-for", IMPOSTOR]])]);
	add("seq-pair-blocked", [post("/api/pair", '{"name":"x"}', [["x-forwarded-for", BLOCKED_PHONE]])], { blocks: true });
	add("seq-pair-big-body", [post("/api/pair", `{"name":"${"x".repeat(40_000)}"}`)]);
	add("seq-pair-name-long", [post("/api/pair", `{"name":"${"n".repeat(201)}"}`)]);
	add("seq-pair-not-json", [post("/api/pair", "name=x", [["content-type", "text/plain"]])]);
	add("seq-unpaired-throttle", [
		{ ...post("/api/session", "{}", [["cookie", "__Host-ompdesk=devkey.wrong"]]), repeat: 4 },
	]);
	add(
		"seq-push-state",
		[
			post("/api/push", '{"hideContent":true}', [cookie("devnokey")]),
			{
				method: "GET",
				target: `/${SECRET}/api/push`,
				headers: [
					["host", hostOf(p)],
					["sec-fetch-site", "same-origin"],
					["tailscale-user-login", "me@example.com"],
					["x-forwarded-for", PHONE],
					cookie("devnokey"),
				],
				body: null,
			},
		].map(r => r as Request),
	);
	add("seq-push-subscribe", [
		post(
			"/api/push",
			JSON.stringify({
				subscription: {
					endpoint: "https://fcm.googleapis.com/fcm/send/abc",
					keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
				},
			}),
			[cookie("devnokey")],
		),
		post("/api/push", '{"subscription":null}', [cookie("devnokey")]),
	]);
	add("seq-upload", [post("/upload", "hello", [cookie("devnokey")]), post("/upload", "hello", [cookie("devnowork")])]);
	add("seq-blob", [
		{
			method: "GET",
			target: `/${SECRET}/blob/tok?x=1`,
			headers: [
				["host", hostOf(p)],
				["sec-fetch-site", "same-origin"],
				["tailscale-user-login", "me@example.com"],
				["x-forwarded-for", PHONE],
				cookie("devnokey"),
			],
			body: null,
		},
	]);
	// Webhooks: through serve (the walls apply), and straight at the loopback (the bearer is the credential).
	const hook = (id: string, body: string | null, headers: Header[]): Request => ({
		method: "POST",
		target: `/${SECRET}/hooks/${id}`,
		headers: [
			["host", hostOf(p)],
			["tailscale-user-login", "me@example.com"],
			["x-forwarded-for", PHONE],
			...headers,
		],
		body,
	});
	const bearer: Header = ["authorization", `Bearer ${HOOK_KEY}`];
	add(
		"seq-hook-outcomes",
		["fire", "deny", "off", "ghost"].map(id => hook(id, "run it", [bearer])),
	);
	add("seq-hook-no-bearer", [hook("fire", "x", []), hook("fire", "x", [["authorization", "Basic abc"]])]);
	add("seq-hook-bad-id", [hook("a_b", "x", [bearer]), hook("x".repeat(65), "x", [bearer])]);
	add("seq-hook-detail", [
		hook("fire", "", [bearer]),
		hook("fire", "  line one\n\n   line   two\t\tend  ", [bearer]),
		hook("fire", "가".repeat(500), [bearer]),
		hook("fire", "🙂".repeat(300), [bearer]),
	]);
	add("seq-hook-too-big", [hook("fire", "a".repeat(70_000), [bearer])]);
	add("seq-hook-get", [{ ...hook("fire", null, [bearer]), method: "GET" }]);
	add("seq-hook-origin", [hook("fire", "x", [bearer, ["origin", "https://evil.example"]])]);
	const direct = (id: string, headers: Header[], method = "POST", body: string | null = "payload"): Request => ({
		method,
		target: `/hooks/${id}`,
		headers: [["host", "127.0.0.1:{port}"], ...headers],
		body,
	});
	add("seq-hook-direct", [
		direct("fire", [bearer]),
		direct("fire", [bearer, ["host", "localhost:{port}"]]),
		direct("fire", [bearer, ["origin", "http://127.0.0.1:{port}"]]),
		direct("fire", [bearer, ["sec-fetch-site", "none"]]),
		direct("fire", [bearer, ["tailscale-funnel-request", "?1"]]),
		{ ...direct("fire", [bearer]), headers: [["host", "evil.example"], bearer] },
		direct("fire", [], "GET", null),
		direct("fire", []),
		direct("fire", [bearer], "POST", "x".repeat(70_000)),
	]);
	add("seq-hook-direct-unpublished", [direct("fire", [bearer])], { policy: policyOf("serve", "unpublished") });
	add("seq-hook-direct-wrong-prefix", [{ ...direct("fire", [bearer]), target: `/${WRONG}/hooks/fire` }]);
	// A page with the root missing; an index while blocked.
	const page = (extra: Header[] = []): Request => ({
		method: "GET",
		target: `/${SECRET}/`,
		headers: [
			["host", hostOf(p)],
			["sec-fetch-site", "same-origin"],
			["tailscale-user-login", "me@example.com"],
			["x-forwarded-for", PHONE],
			...extra,
		],
		body: null,
	});
	add("seq-page-no-root", [page(), { ...page(), target: `/${SECRET}/assets/app-abc.js` }], { noRoot: true });
	add(
		"seq-page-blocked-node",
		[
			page([["x-forwarded-for", BLOCKED_PHONE]]).headers.length
				? {
						...page(),
						headers: page().headers.map(([k, v]) =>
							k === "x-forwarded-for" ? [k, BLOCKED_PHONE] : [k, v],
						) as Header[],
					}
				: page(),
		],
		{ blocks: true },
	);
	add(
		"seq-page-blocked-with-cookie",
		[
			{
				...page([cookie("devkey")]),
				headers: page([cookie("devkey")]).headers.map(([k, v]) =>
					k === "x-forwarded-for" ? [k, BLOCKED_PHONE] : [k, v],
				) as Header[],
			},
		],
		{ blocks: true },
	);
	add(
		"seq-page-blocked-korean",
		[
			{
				...page([["accept-language", "ko"]]),
				headers: page([["accept-language", "ko"]]).headers.map(([k, v]) =>
					k === "x-forwarded-for" ? [k, BLOCKED_PHONE] : [k, v],
				) as Header[],
			},
		],
		{ blocks: true },
	);
	add(
		"seq-page-whois-cache",
		[
			{
				...page(),
				headers: page().headers.map(([k, v]) =>
					k === "x-forwarded-for" ? [k, BLOCKED_PHONE] : [k, v],
				) as Header[],
			},
			{
				...page(),
				headers: page().headers.map(([k, v]) =>
					k === "x-forwarded-for" ? [k, BLOCKED_PHONE] : [k, v],
				) as Header[],
			},
		],
		{ blocks: true },
	);
	// The upgrade's refusals: the socket is closed with a bare status.
	const upgrade = (target: string, headers: Header[]): Request => ({
		method: "GET",
		target,
		headers: [
			["host", hostOf(p)],
			["upgrade", "websocket"],
			["connection", "Upgrade"],
			["sec-websocket-version", "13"],
			["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
			...headers,
		],
		body: null,
	});
	const good: Header[] = [
		["origin", originOf(p)],
		["tailscale-user-login", "me@example.com"],
		["x-forwarded-for", PHONE],
	];
	add(
		"seq-upgrade-refusals",
		[
			upgrade(`/${SECRET}/ws`, [...good, ["sec-websocket-protocol", "ompdesk.v1, ticket.abc"], cookie("devkey")]),
			upgrade(`/${SECRET}/ws`, [...good, ["sec-websocket-protocol", "ompdesk.v1"], cookie("devkey")]),
			upgrade(`/${SECRET}/ws`, [...good, ["sec-websocket-protocol", "ticket.abc"], cookie("devkey")]),
			upgrade(`/${SECRET}/ws`, [...good, ["sec-websocket-protocol", "ompdesk.v1, ticket.abc"]]),
			upgrade(`/${SECRET}/ws`, [
				["tailscale-user-login", "me@example.com"],
				["sec-websocket-protocol", "ompdesk.v1, ticket.abc"],
			]),
			upgrade(`/${SECRET}/other`, good),
			upgrade(`/${WRONG}/ws`, good),
			upgrade(`/ws`, good),
			upgrade(`/${SECRET}/ws`, [
				...good.filter(([k]) => k !== "origin"),
				["sec-websocket-protocol", "ompdesk.v1, ticket.abc"],
			]),
			upgrade(`/${SECRET}/ws`, [
				...good,
				["sec-fetch-site", "cross-site"],
				["sec-websocket-protocol", "ompdesk.v1, ticket.abc"],
			]),
			upgrade(`/${SECRET}/ws?x=1`, [["host", "evil.example"], ...good]),
		].map(r =>
			r.headers.filter(([k]) => k === "host").length > 1
				? {
						...r,
						headers: r.headers
							.filter(
								([k, v], i, all) =>
									!!(
										k !== "host" ||
										i ===
											all.findIndex(
												([kk]) => kk === "host" && v === (all.find(([a]) => a === "host") as Header)[1],
											)
									),
							)
							.slice(0, 0)
							.concat(
								r.headers.filter(([k]) => k !== "host").length
									? ([["host", "evil.example"], ...r.headers.filter(([k]) => k !== "host")] as Header[])
									: [],
							),
					}
				: r,
		),
	);
	add("seq-upgrade-pending", [upgrade(`/${SECRET}/ws`, good)], { policy: policyOf("serve", "pending") });
	add("seq-upgrade-unpublished", [upgrade(`/${SECRET}/ws`, good)], { policy: policyOf("serve", "unpublished") });
	return rows;
}

async function generate(): Promise<{ rows: Row[]; fixtures: unknown }> {
	const work = mkdtempSync(join(tmpdir(), "web-matrix-static-"));
	cpSync(STATIC_DIR, work, { recursive: true });
	setStaticTimes(work);
	const rows: Row[] = [];
	try {
		const seen = new Set<string>();
		const choices = [...pairwise(dimensions()), ...precedenceChoices()];
		for (const choice of choices) {
			const spec = build(choice) as unknown as Spec;
			const row = finish(spec, choice);
			const key = JSON.stringify([row.policy, row.blocks, row.requests]);
			if (seen.has(key)) continue;
			seen.add(key);
			rows.push(await runRow(row, work));
		}
		for (const sequence of sequences()) rows.push(await runRow(sequence, work));
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	return {
		rows,
		fixtures: {
			now: NOW,
			secret: SECRET,
			wrong: WRONG,
			hookKey: HOOK_KEY,
			pushKey: PUSH_KEY,
			allowed: ALLOWED,
			deviceKey: DEVICE_KEY,
			secrets: SECRETS,
			devices: devicesDocument(),
			blocked: blockedDocument(),
			whois: {
				[PHONE]: { nodeId: "nPHONE1", nodeName: "s25u", login: "me@example.com" },
				[BLOCKED_PHONE]: { nodeId: "nBLOCKED", nodeName: "bad-phone", login: "me@example.com" },
				[IMPOSTOR]: { nodeId: "nOTHER", nodeName: "other", login: "someone@else.example" },
			},
		},
	};
}

void existsSync;
void statSync;

describe("web edge request matrix", () => {
	let work: string | null = null;
	afterAll(() => {
		if (work) rmSync(work, { recursive: true, force: true });
	});

	if (WRITE) {
		it("rewrites the rows from the TypeScript server", async () => {
			writeStaticFixtures();
			const { rows, fixtures } = await generate();
			const head = JSON.stringify({ version: 1, fixtures }, null, "\t").replace(/\n}$/, "");
			writeFileSync(
				MATRIX_FILE,
				`${head},\n\t"rows": [\n${rows.map(row => `\t\t${JSON.stringify(row)}`).join(",\n")}\n\t]\n}\n`,
			);
			expect(rows.length).toBeGreaterThan(100);
		}, 600_000);
		return;
	}

	const stored = JSON.parse(readFileSync(MATRIX_FILE, "utf8")) as { rows: Row[] };

	it("answers every stored row as it was captured", async () => {
		work = mkdtempSync(join(tmpdir(), "web-matrix-static-"));
		cpSync(STATIC_DIR, work, { recursive: true });
		setStaticTimes(work);
		const drift: string[] = [];
		for (const row of stored.rows) {
			const again = await runRow(row, work);
			if (
				JSON.stringify(again.answers) !== JSON.stringify(row.answers) ||
				JSON.stringify(again.effects) !== JSON.stringify(row.effects)
			)
				drift.push(row.id);
		}
		expect(drift).toEqual([]);
	}, 600_000);
});
