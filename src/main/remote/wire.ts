/**
 * Remote-device framing over one TCP socket: a 4-byte big-endian length, then
 * at most 16 MiB of payload. Handshake payloads are plain JSON; after
 * `secure()` every payload is `counter(12) || AES-256-GCM(JSON) || tag(16)`
 * with the 96-bit counter as nonce, one key per direction, and received
 * counters that must strictly increase. Any framing, decryption, counter or
 * JSON failure destroys the socket.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { Socket } from "node:net";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const PING_INTERVAL_MS = 10_000;
export const DEAD_AFTER_MS = 30_000;
/** How long a wake's liveness check waits for any frame from the peer before it drops the link. */
export const WAKE_CHECK_MS = 3_000;
/** How long a graceful close waits for the peer before destroying the socket. */
const CLOSE_GRACE_MS = 1_000;

const HEADER_BYTES = 4;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A message whose frame would pass `MAX_FRAME_BYTES`: nothing was sent. */
export class FrameTooLargeError extends Error {
	constructor(bytes: number) {
		super(`frame of ${bytes} bytes exceeds the 16 MiB cap`);
	}
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

/** Encrypts outgoing payloads under one direction key with a counting nonce. */
export class FrameSealer {
	readonly #key: Buffer;
	#counter = 0n;

	constructor(key: Buffer) {
		this.#key = key;
	}

	seal(plaintext: Buffer): Buffer {
		const iv = nonce(this.#counter++);
		const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
		const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return Buffer.concat([iv, body, cipher.getAuthTag()]);
	}
}

/** Decrypts incoming payloads; throws on a bad tag or a counter that did not increase. */
export class FrameOpener {
	readonly #key: Buffer;
	#last = -1n;

	constructor(key: Buffer) {
		this.#key = key;
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
		// Sealing adds bytes, never removes them: a message already past the cap is refused before it is encrypted.
		if (json.length > MAX_FRAME_BYTES) throw new FrameTooLargeError(json.length);
		const payload = this.#sealer ? this.#sealer.seal(json) : json;
		const frame = encodeFrame(payload);
		this.#traffic?.("tx", message, frame.length);
		this.#socket.write(frame);
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
		const json = this.#opener ? this.#opener.open(payload) : payload;
		const message: unknown = JSON.parse(json.toString("utf8"));
		if (typeof message !== "object" || message === null || Array.isArray(message)) throw new Error("not an object");
		if (!("t" in message) || typeof message.t !== "string") throw new Error("message without a type");
		return message as WireMessage;
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
