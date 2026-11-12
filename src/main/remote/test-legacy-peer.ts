/**
 * The remote link as the released TypeScript speaks it (v0.127.0 and every release before the Rust core took the
 * link, native-rust ledger R2/R3): `Link` with its framing, sealing and deflate context, the X25519 keys and the key
 * schedule, and both handshakes. A computer that still runs such a release talks to this one's core, so the tests
 * use it as the other end of a real socket: what the core sends must open, inflate and parse here, and what this
 * sends must reach the core's links unchanged. Never imported by the app.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	createSecretKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import type { Socket } from "node:net";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const PING_INTERVAL_MS = 10_000;
export const DEAD_AFTER_MS = 30_000;
/** How long a wake's liveness check waits for any frame from the peer before it drops the link. */
export const WAKE_CHECK_MS = 3_000;
/** How long a graceful close waits for the peer before destroying the socket. */
const CLOSE_GRACE_MS = 1_000;

/**
 * The smallest message worth deflating. Each frame is deflated on its own, with no context shared across frames, so a
 * small one gains little. Measured on a session journal's JSON: about 3x smaller at level 3, 1.4 ms for 300 KB.
 */
export const DEFLATE_MIN_BYTES = 1024;
const DEFLATE_LEVEL = 3;
/** The first byte of a deflated payload; a JSON one starts with `{`. */
const DEFLATED = 0x00;
/** The first byte of a payload deflated against the link's context. */
const DEFLATED_IN_CONTEXT = 0x01;
/**
 * How much of the messages before it a message is deflated against: deflate's whole window. Most of a live stream's
 * frame repeats the last ones (a subagent's progress snapshot, the same keys, its recent output lines), which a frame
 * deflated on its own cannot use: four subagents' frames crossed in 3 to 4 times fewer bytes this way (28 Oct 2026,
 * `link-traffic-subagents.test.ts`).
 */
export const CONTEXT_BYTES = 32 * 1024;
/** Smaller than this crosses as JSON: a ping or a pong. */
export const CONTEXT_MIN_BYTES = 64;
/**
 * Up to this size a message is deflated harder: a live frame takes about 0.05 ms either way, and level 6 made the
 * stream 25 % smaller than level 3. A larger read (a transcript page) keeps level 3: 9 ms for 1.5 MB, 19 ms at 6.
 */
const CONTEXT_HARD_MAX_BYTES = 64 * 1024;
const CONTEXT_HARD_LEVEL = 6;

const HEADER_BYTES = 4;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A message whose frame would pass `MAX_FRAME_BYTES`: nothing was sent. */
export class FrameTooLargeError extends Error {
	constructor(bytes: number) {
		super(`frame of ${bytes} bytes exceeds the 16 MiB cap`);
	}
}

/** `json` deflated behind its marker byte, or `json` itself when deflating does not make it smaller. */
function deflated(json: Buffer): Buffer {
	const packed = deflateRawSync(json, { level: DEFLATE_LEVEL });
	return packed.length + 1 < json.length ? Buffer.concat([Buffer.of(DEFLATED), packed]) : json;
}

/**
 * The last {@link CONTEXT_BYTES} of the messages one end deflated against the context (or inflated from it), as one
 * contiguous dictionary. The backing buffer holds twice the window, so it slides once a window, not on every message.
 */
class DeflateContext {
	readonly #buffer = Buffer.allocUnsafe(2 * CONTEXT_BYTES);
	#length = 0;

	/** The dictionary for the next message; undefined before the first, which zlib takes with none. */
	get dictionary(): Buffer | undefined {
		return this.#length === 0
			? undefined
			: this.#buffer.subarray(Math.max(0, this.#length - CONTEXT_BYTES), this.#length);
	}

	append(json: Buffer): void {
		if (json.length >= CONTEXT_BYTES) {
			json.copy(this.#buffer, 0, json.length - CONTEXT_BYTES);
			this.#length = CONTEXT_BYTES;
			return;
		}
		if (this.#length + json.length > this.#buffer.length) {
			this.#buffer.copyWithin(0, this.#length - CONTEXT_BYTES, this.#length);
			this.#length = CONTEXT_BYTES;
		}
		json.copy(this.#buffer, this.#length);
		this.#length += json.length;
	}
}

/** `json` deflated against `context` behind its marker byte, or null when that does not make it smaller. */
function deflatedInContext(json: Buffer, context: DeflateContext): Buffer | null {
	const level = json.length <= CONTEXT_HARD_MAX_BYTES ? CONTEXT_HARD_LEVEL : DEFLATE_LEVEL;
	const { dictionary } = context;
	const packed = deflateRawSync(json, dictionary ? { level, dictionary } : { level });
	return packed.length + 1 < json.length ? Buffer.concat([Buffer.of(DEFLATED_IN_CONTEXT), packed]) : null;
}

export function encodeFrame(payload: Buffer): Buffer {
	if (payload.length > MAX_FRAME_BYTES) throw new FrameTooLargeError(payload.length);
	const header = Buffer.allocUnsafe(HEADER_BYTES);
	header.writeUInt32BE(payload.length);
	return Buffer.concat([header, payload]);
}

/** Splits a byte stream into frame payloads; throws on an oversized length. */
export class FrameDecoder {
	#chunks: Buffer[] = [];
	#size = 0;
	#need: number | null = null;

	push(chunk: Buffer): Buffer[] {
		this.#chunks.push(chunk);
		this.#size += chunk.length;
		const frames: Buffer[] = [];
		for (;;) {
			if (this.#need === null) {
				if (this.#size < HEADER_BYTES) break;
				const head = this.#flatten();
				const length = head.readUInt32BE(0);
				if (length > MAX_FRAME_BYTES) throw new Error(`frame of ${length} bytes exceeds the 16 MiB cap`);
				this.#need = length;
			}
			if (this.#size < HEADER_BYTES + this.#need) break;
			const all = this.#flatten();
			const end = HEADER_BYTES + this.#need;
			frames.push(Buffer.from(all.subarray(HEADER_BYTES, end)));
			const rest = all.subarray(end);
			this.#chunks = rest.length ? [rest] : [];
			this.#size = rest.length;
			this.#need = null;
		}
		return frames;
	}

	#flatten(): Buffer {
		if (this.#chunks.length !== 1) this.#chunks = [Buffer.concat(this.#chunks, this.#size)];
		return this.#chunks[0] ?? Buffer.alloc(0);
	}
}

function nonce(counter: bigint): Buffer {
	const iv = Buffer.alloc(NONCE_BYTES);
	iv.writeUInt32BE(Number(counter >> 64n), 0);
	iv.writeBigUInt64BE(counter & 0xffff_ffff_ffff_ffffn, 4);
	return iv;
}

/**
 * Encrypts outgoing payloads under one direction key with a counting nonce. The key is made a KeyObject once: given
 * the raw bytes, `createCipheriv` imported them again for every frame, most of what sealing cost (a busy tab's stream to
 * two computers, `fanout-cpu-report.test.ts`: 23.5 ms of sealing, 3.1 ms with the key imported once).
 */
export class FrameSealer {
	readonly #key: KeyObject;
	#counter = 0n;

	constructor(key: Buffer) {
		this.#key = createSecretKey(key);
	}

	seal(plaintext: Buffer): Buffer {
		const iv = nonce(this.#counter++);
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
		const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return Buffer.concat([iv, body, cipher.getAuthTag()]);
	}
}

/** Decrypts incoming payloads; throws on a bad tag or a counter that did not increase. Its key is imported once too. */
export class FrameOpener {
	readonly #key: KeyObject;
	#last = -1n;

	constructor(key: Buffer) {
		this.#key = createSecretKey(key);
	}

	open(frame: Buffer): Buffer {
		if (frame.length < NONCE_BYTES + TAG_BYTES) throw new Error("encrypted frame too short");
		const iv = frame.subarray(0, NONCE_BYTES);
		const counter = (BigInt(iv.readUInt32BE(0)) << 64n) | iv.readBigUInt64BE(4);
		if (counter <= this.#last) throw new Error("frame counter did not increase");
		const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
		decipher.setAuthTag(frame.subarray(frame.length - TAG_BYTES));
		const plain = Buffer.concat([
			decipher.update(frame.subarray(NONCE_BYTES, frame.length - TAG_BYTES)),
			decipher.final(),
		]);
		this.#last = counter;
		return plain;
	}
}

/** A decoded JSON message: an object with a string `t`. */
export type WireMessage = { t: string } & Record<string, unknown>;

/** Why a link ended: the peer or the network closed it, silence, a bad frame, or this side destroyed it. */
export type LinkCloseReason = "closed" | "dead" | "protocol" | "local";

export interface Liveness {
	pingMs: number;
	deadMs: number;
}

/** Sees every message the link sends (`tx`) or receives (`rx`) with its wire bytes, header and encryption overhead included. */
export type TrafficHandler = (direction: "tx" | "rx", message: object, bytes: number) => void;

interface Waiter {
	resolve: (message: WireMessage) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/**
 * One framed connection. Handshake code pulls plain messages with `receive()`,
 * switches to encryption with `secure()`, then hands every later message to
 * `listen()`, which also answers pings and drops a peer silent for `deadMs`.
 * Payloads stay raw until delivered, so frames that arrive with the last
 * plain message are decrypted under the keys installed after it.
 */
export class Link {
	readonly #socket: Socket;
	readonly #liveness: Liveness;
	readonly #decoder = new FrameDecoder();
	readonly #closeHandlers: (() => void)[] = [];
	#pending: Buffer[] = [];
	#waiter: Waiter | null = null;
	#listener: ((message: WireMessage) => void) | null = null;
	#sealer: FrameSealer | null = null;
	#opener: FrameOpener | null = null;
	#pingTimer: NodeJS.Timeout | undefined;
	#traffic: TrafficHandler | null = null;
	#check: { promise: Promise<boolean>; resolve: (alive: boolean) => void; timer: NodeJS.Timeout } | null = null;
	#lastReceived = Date.now();
	#closed = false;
	#closeReason: LinkCloseReason | null = null;
	#closing = false;
	#deflate = false;
	/** What this end deflates against (`deflateSent({context: true})`); null while it does not. */
	#sentContext: DeflateContext | null = null;
	/** What the peer deflated against, made at its first such message. */
	#receivedContext: DeflateContext | null = null;

	constructor(socket: Socket, liveness: Liveness = { pingMs: PING_INTERVAL_MS, deadMs: DEAD_AFTER_MS }) {
		this.#socket = socket;
		this.#liveness = liveness;
		socket.setNoDelay(true);
		socket.on("data", chunk => {
			let frames: Buffer[];
			try {
				frames = this.#decoder.push(chunk);
			} catch {
				this.destroy("protocol");
				return;
			}
			this.#pending.push(...frames);
			this.#drain();
		});
		// "close" follows every error; the error itself carries nothing to act on.
		socket.on("error", () => {});
		socket.on("close", () => this.#finish(this.#closing ? "local" : "closed"));
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Why the link ended; null while it is open. */
	get closeReason(): LinkCloseReason | null {
		return this.#closeReason;
	}

	/** Send one message, encrypted once `secure()` ran. Throws `FrameTooLargeError` when it exceeds the frame cap. */
	send(message: object): void {
		if (this.#closed) return;
		const json = Buffer.from(JSON.stringify(message));
		// The cap is the receiver's after inflating: a message past it is refused whatever it would deflate to.
		if (json.length > MAX_FRAME_BYTES) throw new FrameTooLargeError(json.length);
		const body = this.#sentContext
			? json.length >= CONTEXT_MIN_BYTES
				? deflatedInContext(json, this.#sentContext)
				: null
			: this.#deflate && json.length >= DEFLATE_MIN_BYTES
				? deflated(json)
				: null;
		const payload = this.#sealer ? this.#sealer.seal(body ?? json) : (body ?? json);
		const frame = encodeFrame(payload);
		this.#traffic?.("tx", message, frame.length);
		this.#socket.write(frame);
		// Only a message that crossed in the context joins it, on the peer's side too (its marker byte says so), and
		// only once it was written: a send that threw before leaves both copies as they were.
		if (body && this.#sentContext) this.#sentContext.append(json);
	}

	/**
	 * Deflate large messages from now on: the peer said it reads them (its hello's `deflate`). With `context` (its
	 * hello's `deflateContext`) every message of `CONTEXT_MIN_BYTES` or more goes deflated against the ones before it
	 * when that makes it smaller.
	 */
	deflateSent(options: { context?: boolean } = {}): void {
		this.#deflate = true;
		if (options.context) this.#sentContext ??= new DeflateContext();
	}

	/** Count what crosses this link from now on; one handler. */
	onTraffic(handler: TrafficHandler): void {
		this.#traffic = handler;
	}

	/** The next message; rejects on timeout, or on close once nothing received is left. */
	receive(timeoutMs: number): Promise<WireMessage> {
		if (this.#waiter || this.#listener) return Promise.reject(new Error("link already has a reader"));
		if (this.#closed && this.#pending.length === 0) return Promise.reject(new Error("connection closed"));
		const { promise, resolve, reject } = Promise.withResolvers<WireMessage>();
		const timer = setTimeout(() => {
			this.#waiter = null;
			reject(new Error("handshake timed out"));
		}, timeoutMs);
		this.#waiter = { resolve, reject, timer };
		this.#drain();
		return promise;
	}

	/** Encrypt everything sent and require everything received to decrypt from now on. */
	secure(sendKey: Buffer, receiveKey: Buffer): void {
		this.#sealer = new FrameSealer(sendKey);
		this.#opener = new FrameOpener(receiveKey);
	}

	/** Deliver every later message to `onMessage` and start ping/pong liveness. */
	listen(onMessage: (message: WireMessage) => void): void {
		if (this.#closed) return;
		this.#listener = onMessage;
		this.#lastReceived = Date.now();
		this.#pingTimer = setInterval(() => {
			if (Date.now() - this.#lastReceived >= this.#liveness.deadMs) this.destroy("dead");
			else this.send({ t: "ping" });
		}, this.#liveness.pingMs);
		this.#pingTimer.unref();
		this.#drain();
	}

	onClose(handler: () => void): void {
		if (this.#closed) handler();
		else this.#closeHandlers.push(handler);
	}

	/**
	 * Ask the peer now whether it is there: resolves true on the next frame from it, and drops the link (`dead`)
	 * when none arrives within `windowMs`, so a link that went silent does not wait for the dead timer.
	 */
	check(windowMs: number): Promise<boolean> {
		if (this.#closed) return Promise.resolve(false);
		if (this.#check) return this.#check.promise;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => this.destroy("dead"), windowMs);
		this.#check = { promise, resolve, timer };
		this.send({ t: "ping" });
		return promise;
	}

	/** Flush what was sent, then close; destroys if the peer does not finish in time. */
	close(): void {
		if (this.#closed) return;
		this.#closing = true;
		this.#socket.end();
		setTimeout(() => this.#socket.destroy(), CLOSE_GRACE_MS).unref();
	}

	destroy(reason: LinkCloseReason = "local"): void {
		this.#socket.destroy();
		this.#finish(reason);
	}

	#decode(payload: Buffer): WireMessage {
		// Nothing is deflated before `secure()` (the handshake is JSON): an unauthenticated peer never gets main to inflate.
		if (!this.#opener && (payload[0] === DEFLATED || payload[0] === DEFLATED_IN_CONTEXT)) {
			throw new Error("deflated frame before the link is secure");
		}
		const body = this.#opener ? this.#opener.open(payload) : payload;
		const json =
			body[0] === DEFLATED
				? inflateRawSync(body.subarray(1), { maxOutputLength: MAX_FRAME_BYTES })
				: body[0] === DEFLATED_IN_CONTEXT
					? this.#inflateInContext(body.subarray(1))
					: body;
		const message: unknown = JSON.parse(json.toString("utf8"));
		if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("not an object");
		if (!("t" in message) || typeof message.t !== "string") throw new Error("message without a type");
		return message as WireMessage;
	}

	#inflateInContext(packed: Buffer): Buffer {
		this.#receivedContext ??= new DeflateContext();
		const { dictionary } = this.#receivedContext;
		const json = inflateRawSync(
			packed,
			dictionary ? { dictionary, maxOutputLength: MAX_FRAME_BYTES } : { maxOutputLength: MAX_FRAME_BYTES },
		);
		this.#receivedContext.append(json);
		return json;
	}

	#drain(): void {
		// A handshake reader still gets frames that arrived just before the close (a final pair-fail).
		while (this.#pending.length > 0 && (this.#waiter || (this.#listener && !this.#closed))) {
			const payload = this.#pending.shift() as Buffer;
			let message: WireMessage;
			try {
				message = this.#decode(payload);
			} catch {
				this.#pending = [];
				this.destroy("protocol");
				break;
			}
			this.#lastReceived = Date.now();
			this.#traffic?.("rx", message, payload.length + HEADER_BYTES);
			this.#settleCheck(true);
			const waiter = this.#waiter;
			if (waiter) {
				this.#waiter = null;
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			} else if (message.t === "ping") {
				this.send({ t: "pong" });
			} else if (message.t !== "pong") {
				this.#listener?.(message);
			}
		}
		const waiter = this.#waiter;
		if (this.#closed && waiter) {
			this.#waiter = null;
			clearTimeout(waiter.timer);
			waiter.reject(new Error("connection closed"));
		}
	}

	#settleCheck(alive: boolean): void {
		const check = this.#check;
		if (!check) return;
		this.#check = null;
		clearTimeout(check.timer);
		check.resolve(alive);
	}

	#finish(reason: LinkCloseReason): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeReason = reason;
		clearInterval(this.#pingTimer);
		this.#settleCheck(false);
		this.#listener = null;
		this.#drain();
		for (const handler of this.#closeHandlers.splice(0)) handler();
	}
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32 of `bytes`, lowercase, unpadded. */
export function base32(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
		buffer &= (1 << bits) - 1;
	}
	if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
	return out.toLowerCase();
}

export interface KeyPair {
	/** Raw 32-byte X25519 public key, base64url. */
	publicKey: string;
	privateKey: KeyObject;
}

const RAW_KEY = /^[A-Za-z0-9_-]{43}$/;

export function isRawKey(value: string): boolean {
	return RAW_KEY.test(value);
}

function rawPublicKey(key: KeyObject): string {
	const { x } = key.export({ format: "jwk" });
	if (typeof x !== "string") throw new Error("X25519 key has no public component");
	return x;
}

export function generateKeyPair(): KeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("x25519");
	return { publicKey: rawPublicKey(publicKey), privateKey };
}

/** The persisted form of a private key: its JWK `d`. */
export function exportPrivateKey(key: KeyObject): string {
	const { d } = key.export({ format: "jwk" });
	if (typeof d !== "string") throw new Error("X25519 key has no private component");
	return d;
}

/** Rebuild a key pair from its persisted raw parts; throws when they do not match. */
export function importKeyPair(publicKey: string, privateKey: string): KeyPair {
	if (!isRawKey(publicKey) || !isRawKey(privateKey)) throw new Error("malformed X25519 key");
	const key = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: privateKey, x: publicKey }, format: "jwk" });
	if (rawPublicKey(createPublicKey(key)) !== publicKey) throw new Error("X25519 key pair mismatch");
	return { publicKey, privateKey: key };
}

/** X25519(private, peer public); throws on a malformed or low-order peer key. */
export function dh(privateKey: KeyObject, peerPublicKey: string): Buffer {
	if (!isRawKey(peerPublicKey)) throw new Error("malformed X25519 public key");
	const publicKey = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peerPublicKey }, format: "jwk" });
	return diffieHellman({ privateKey, publicKey });
}

/** SHA-256 of the canonical transcript: the JSON array of label and fields in protocol order. */
export function transcriptHash(label: string, fields: readonly string[]): Buffer {
	return createHash("sha256")
		.update(JSON.stringify([label, ...fields]))
		.digest();
}

const AUTH_INFO = "ompdesk-auth-v2";

export function authTranscript(fields: readonly string[]): Buffer {
	return transcriptHash(AUTH_INFO, fields);
}

export interface DirectionKeys {
	/** Client → host. */
	ab: Buffer;
	/** Host → client. */
	ba: Buffer;
}

/** Split `HKDF(ikm, info = "ompdesk-auth-v1" || transcript hash)` into the two direction keys. */
export function authKeys(ikm: Buffer, transcript: Buffer): DirectionKeys {
	const info = Buffer.concat([Buffer.from(AUTH_INFO), transcript]);
	const okm = Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 64));
	return { ab: okm.subarray(0, 32), ba: okm.subarray(32) };
}

export function randomDeviceId(): string {
	return base32(randomBytes(16));
}

/** The handshake's transcript over both parties, client first (`authTranscriptOf` in protocol.ts). */
export function legacyTranscript(
	client: { deviceId: string; ephPub: string; staticPub: string },
	host: { deviceId: string; ephPub: string; staticPub: string },
): Buffer {
	return authTranscript([
		client.deviceId,
		client.ephPub,
		client.staticPub,
		host.deviceId,
		host.ephPub,
		host.staticPub,
	]);
}

/** A peer's identity as the released TypeScript kept it. */
export interface LegacyIdentity {
	deviceId: string;
	publicKey: string;
	privateKey: KeyObject;
}

export function legacyIdentity(): LegacyIdentity {
	return { deviceId: randomDeviceId(), ...generateKeyPair() };
}

/** The released client's handshake on a connected link (`handshakeOn`), up to the host's hello. */
export async function legacyClientHandshake(
	link: Link,
	me: LegacyIdentity,
	hello: Record<string, unknown>,
): Promise<{ answer: WireMessage; hello: WireMessage }> {
	const eph = generateKeyPair();
	link.send({
		t: "auth-init",
		v: 2,
		deviceId: me.deviceId,
		name: hello.name,
		ephPub: eph.publicKey,
		staticPub: me.publicKey,
	});
	const answer = await link.receive(10_000);
	if (answer.t !== "auth-resp") throw Object.assign(new Error(String(answer.code)), { code: answer.code });
	const ephPub = String(answer.ephPub);
	const staticPub = String(answer.staticPub);
	const ikm = Buffer.concat([dh(eph.privateKey, ephPub), dh(me.privateKey, ephPub), dh(eph.privateKey, staticPub)]);
	const keys = authKeys(
		ikm,
		legacyTranscript(
			{ deviceId: me.deviceId, ephPub: eph.publicKey, staticPub: me.publicKey },
			{ deviceId: String(answer.deviceId), ephPub, staticPub },
		),
	);
	link.secure(keys.ab, keys.ba);
	link.send({ t: "hello", protocol: 1, ...hello });
	return { answer, hello: await link.receive(10_000) };
}

/** The released host's handshake on an accepted link (`#handshake`/`#auth`), its gate and records left out. */
export async function legacyHostHandshake(
	link: Link,
	me: LegacyIdentity,
	hello: Record<string, unknown>,
): Promise<{ init: WireMessage; hello: WireMessage }> {
	const init = await link.receive(10_000);
	const eph = generateKeyPair();
	link.send({
		t: "auth-resp",
		deviceId: me.deviceId,
		name: hello.name,
		ephPub: eph.publicKey,
		staticPub: me.publicKey,
	});
	const ephPub = String(init.ephPub);
	const staticPub = String(init.staticPub);
	const ikm = Buffer.concat([dh(eph.privateKey, ephPub), dh(eph.privateKey, staticPub), dh(me.privateKey, ephPub)]);
	const keys = authKeys(
		ikm,
		legacyTranscript(
			{ deviceId: String(init.deviceId), ephPub, staticPub },
			{ deviceId: me.deviceId, ephPub: eph.publicKey, staticPub: me.publicKey },
		),
	);
	link.secure(keys.ba, keys.ab);
	const deviceHello = await link.receive(10_000);
	link.send({ t: "hello", protocol: 1, ...hello });
	return { init, hello: deviceHello };
}
