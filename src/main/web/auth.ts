/**
 * What every request to the web server must pass before it is routed (design §5.3). Behind `tailscale serve`:
 * the secret path prefix only serve's target carries (a request without it never came through serve, so no
 * header on it is believed and it is answered 404), the `Host` and `Origin` of the one published address,
 * `Sec-Fetch-Site`, and the identity headers serve adds (RFC 2047 encoded when not ASCII) against the allowed
 * Tailscale logins. A `Tailscale-Funnel-Request` header means the request came from the public internet and is
 * always refused. Identity is Tailscale's: an allowed login's first visit makes its device (server.ts); these
 * walls only decide who may ask. A local process can still forge the headers *and* read the prefix from the
 * serve config or the 0600 secret file, but such a process runs as the user and could read the cookie store
 * anyway. Also the device cookie's name, parsing and attributes, the one-time tokens (WebSocket tickets, proof
 * nonces) and the check of a device's key signature.
 */
import { createPublicKey, type JsonWebKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { allowedLogin } from "../../shared/mobile-web";

/** What the server accepts; `host`/`publicPort`/`secure` describe the address the page is reached at. */
export interface RequestPolicy {
	/** The published name (`<machine>.<tailnet>.ts.net`), or `127.0.0.1` before serve is configured. */
	host: string;
	/** The port in the published address (it differs from the loopback port when serve moved to a free one). */
	publicPort: number;
	/** The page is served over HTTPS (`tailscale serve`): `Secure` cookies, `https://` origin. */
	secure: boolean;
	/**
	 * The secret first path segment of the serve handler's target. Null until serve is published: nothing is
	 * served then, and with it set only a request carrying it is.
	 */
	servePrefix: string | null;
	/**
	 * The secret this host publishes under, known before serve's handler is confirmed (a relaunched host listens a
	 * few seconds before its first serve status). Until `servePrefix` is set, a request carrying it is answered 503
	 * (come back shortly) instead of 404: serve kept forwarding to this address while the app restarted, and a page
	 * whose lazy chunk got 404 in that window gave the chunk up for good though this build has it (e2e
	 * web-no-reload: Settings opened empty after the host's update). A request without it still gets the bare 404.
	 */
	pendingPrefix?: string | null;
	allowedUsers: () => readonly string[];
}

/** What a request is: a page load, an API call/upload/blob, or the WebSocket upgrade. */
export type RequestKind = "page" | "api" | "ws";

/** Why a request is refused: the walls the page has a message for, or any other. */
export type RefusalReason = "user not allowed" | "no tailscale user" | "other";

export type RequestCheck =
	/** `target` is the request target with the serve prefix taken off (`/ws`, `/api/session?x=1`). */
	| { ok: true; login: string; target: string }
	| { ok: false; status: number; reason: string; why: RefusalReason; login: string | null };

/** `https://host:port` as the browser writes `Origin` (the default port is left out). */
export function originOf(policy: Pick<RequestPolicy, "host" | "publicPort" | "secure">): string {
	const scheme = policy.secure ? "https" : "http";
	const standard = policy.secure ? 443 : 80;
	return `${scheme}://${hostHeaderOf(policy.host, policy.publicPort, standard)}`;
}

function hostHeaderOf(host: string, port: number, standard: number): string {
	return port === standard ? host : `${host}:${port}`;
}

/** A header's single value (Node joins repeats of most headers with ", "; arrays only for set-cookie). */
function single(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value.join(", ") : value;
}

const MIME_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

/**
 * Decode RFC 2047 encoded words (`=?utf-8?q?…?=`, `=?UTF-8?B?…?=`) as Tailscale writes a non-ASCII login or
 * name; plain text is returned as it is. A charset other than UTF-8 or Latin-1 is left undecoded.
 */
export function decodeMimeWords(value: string): string {
	// Whitespace between two adjacent encoded words is not content (RFC 2047 §6.2).
	const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
	return joined.replace(MIME_WORD, (word, charset: string, encoding: string, text: string) => {
		const label = charset.toLowerCase().replace(/\*.*$/, "");
		if (label !== "utf-8" && label !== "utf8" && label !== "iso-8859-1" && label !== "us-ascii") return word;
		let bytes: Buffer;
		if (encoding.toLowerCase() === "b") {
			bytes = Buffer.from(text, "base64");
		} else {
			const raw = text.replace(/_/g, " ");
			const out: number[] = [];
			for (let index = 0; index < raw.length; index++) {
				const hex = raw[index] === "=" ? raw.slice(index + 1, index + 3) : "";
				if (/^[0-9a-fA-F]{2}$/.test(hex)) {
					out.push(Number.parseInt(hex, 16));
					index += 2;
				} else {
					out.push(raw.charCodeAt(index) & 0xff);
				}
			}
			bytes = Buffer.from(out);
		}
		return new TextDecoder(label.startsWith("iso") ? "iso-8859-1" : "utf-8").decode(bytes);
	});
}

/** The login `tailscale serve` put in `Tailscale-User-Login`, decoded; null when the header is missing or empty. */
export function tailscaleLogin(headers: IncomingHttpHeaders): string | null {
	const raw = single(headers["tailscale-user-login"]);
	if (!raw) return null;
	const login = decodeMimeWords(raw).trim();
	return login === "" ? null : login;
}

/**
 * `target` without the secret first segment, or null when it does not start with `/<secret>` (the comparison does not
 * leak how much of the secret matched): `/<secret>` → `/`, `/<secret>/ws?x=1` → `/ws?x=1`.
 */
export function stripServePrefix(target: string, secret: string): string | null {
	if (!target.startsWith("/")) return null;
	const end = target.slice(1).search(/[/?#]/);
	const segment = end === -1 ? target.slice(1) : target.slice(1, 1 + end);
	const given = Buffer.from(segment);
	const wanted = Buffer.from(secret);
	if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
	const rest = end === -1 ? "" : target.slice(1 + end);
	if (rest === "") return "/";
	return rest.startsWith("/") ? rest : `/${rest}`;
}

/** Run every check for one request. `remoteAddress` is the socket's peer: only the loopback may speak for serve. */
export function checkRequest(input: {
	headers: IncomingHttpHeaders;
	method: string;
	kind: RequestKind;
	/** The request target as it arrived (`req.url`), prefix included. */
	url: string;
	remoteAddress: string | undefined;
	policy: RequestPolicy;
}): RequestCheck {
	const { headers, method, kind, url, remoteAddress, policy } = input;
	const refuse = (
		status: number,
		reason: string,
		why: RefusalReason = "other",
		login: string | null = null,
	): RequestCheck => ({
		ok: false,
		status,
		reason,
		why,
		login,
	});

	if (!isLoopbackAddress(remoteAddress)) return refuse(403, "not a loopback peer");
	if (headers["tailscale-funnel-request"] !== undefined) return refuse(403, "funnel request");

	// Not through serve (or not published yet): a bare 404, and no header on the request is read. Under the secret
	// this host is about to publish, a 503: the handler is there, this process has not confirmed it yet.
	if (policy.servePrefix === null) {
		const pending = policy.pendingPrefix ?? null;
		if (pending !== null && stripServePrefix(url, pending) !== null) return refuse(503, "not published yet");
		return refuse(404, "not published");
	}
	const target = stripServePrefix(url, policy.servePrefix);
	if (target === null) return refuse(404, "not through serve");

	const standard = policy.secure ? 443 : 80;
	const expectedHost = hostHeaderOf(policy.host, policy.publicPort, standard).toLowerCase();
	const host = single(headers.host)?.toLowerCase();
	if (host !== expectedHost) return refuse(421, "wrong host");

	const origin = single(headers.origin);
	const mustCarryOrigin = kind === "ws" || (method !== "GET" && method !== "HEAD");
	if (origin === undefined ? mustCarryOrigin : origin.toLowerCase() !== originOf(policy).toLowerCase()) {
		return refuse(403, "wrong origin");
	}

	const site = single(headers["sec-fetch-site"]);
	if (site !== undefined && site !== "same-origin" && site !== "none") {
		// A link from another app opens the page as a cross-site navigation; its cookies are SameSite=Strict
		// anyway, so the page itself may load. Nothing else may be cross-site.
		const navigation = kind === "page" && single(headers["sec-fetch-mode"]) === "navigate";
		if (!navigation) return refuse(403, "cross-site request");
	}

	const login = tailscaleLogin(headers);
	if (login === null) return refuse(403, "no tailscale user", "no tailscale user");
	if (!allowedLogin(policy.allowedUsers(), login))
		return refuse(403, "tailscale user not allowed", "user not allowed", login);
	return { ok: true, login, target };
}

/** 127.0.0.0/8, ::1 and its IPv4-mapped form. */
export function isLoopbackAddress(address: string | undefined): boolean {
	if (!address) return false;
	const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
	return plain === "::1" || /^127\.\d+\.\d+\.\d+$/.test(plain);
}

/** The device cookie: `__Host-` (so no sibling can plant or shadow it) over HTTPS, a plain name over plain HTTP. */
export function cookieName(secure: boolean): string {
	return secure ? "__Host-ompdesk" : "ompdesk";
}

export const COOKIE_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

export function serializeDeviceCookie(value: string, secure: boolean, maxAgeSeconds = COOKIE_MAX_AGE_SECONDS): string {
	return `${cookieName(secure)}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${maxAgeSeconds}`;
}

/** The clearing cookie sent when a credential is refused for good. */
export function clearedDeviceCookie(secure: boolean): string {
	return serializeDeviceCookie("", secure, 0);
}

/** The device cookie's value (`<deviceId>.<secret>`) in a `Cookie` header, or null. */
export function deviceCookieValue(headers: IncomingHttpHeaders, secure: boolean): string | null {
	const header = single(headers.cookie);
	if (!header) return null;
	const wanted = cookieName(secure);
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator === -1) continue;
		if (part.slice(0, separator).trim() === wanted) {
			const value = part.slice(separator + 1).trim();
			return value === "" ? null : value;
		}
	}
	return null;
}

export const TICKET_TTL_MS = 30_000;

/** Random single-use tokens that expire: a WebSocket ticket, or the nonce a device signs to prove its key. */
export class OneTimeTokens<T> {
	readonly #ttlMs: number;
	readonly #now: () => number;
	readonly #live = new Map<string, { value: T; expiresAt: number }>();

	constructor(ttlMs: number = TICKET_TTL_MS, now: () => number = Date.now) {
		this.#ttlMs = ttlMs;
		this.#now = now;
	}

	issue(value: T): { token: string; expiresAt: number } {
		const now = this.#now();
		for (const [token, entry] of this.#live) {
			if (entry.expiresAt <= now) this.#live.delete(token);
		}
		const token = randomBytes(24).toString("base64url");
		const expiresAt = now + this.#ttlMs;
		this.#live.set(token, { value, expiresAt });
		return { token, expiresAt };
	}

	/** The value a token was issued for; the token is spent whether or not it was still valid. */
	redeem(token: string): T | null {
		const entry = this.#live.get(token);
		if (!entry) return null;
		this.#live.delete(token);
		return entry.expiresAt > this.#now() ? entry.value : null;
	}
}

/** The public half of a device's WebCrypto ECDSA P-256 key as `/api/pair` accepts it: no private part, nothing extra. */
export function parsePublicKeyJwk(value: unknown): JsonWebKey | null {
	if (typeof value !== "object" || value === null) return null;
	const jwk: Record<string, unknown> = { ...value };
	const coordinate = /^[A-Za-z0-9_-]{43}$/;
	if (jwk.kty !== "EC" || jwk.crv !== "P-256" || "d" in jwk) return null;
	if (typeof jwk.x !== "string" || typeof jwk.y !== "string") return null;
	if (!coordinate.test(jwk.x) || !coordinate.test(jwk.y)) return null;
	return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/** Whether `signature` (base64url, IEEE P1363 as WebCrypto writes it) signs `nonce` with the device's key. */
export function verifyDeviceProof(publicKey: JsonWebKey, nonce: string, signature: string): boolean {
	try {
		return verify(
			"sha256",
			Buffer.from(nonce),
			{ key: createPublicKey({ key: publicKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
			Buffer.from(signature, "base64url"),
		);
	} catch {
		return false;
	}
}
