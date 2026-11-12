/**
 * A remote link as main holds it: the core (`crates/core/src/remote/link.rs`) owns the socket, the 4-byte framing,
 * AES-256-GCM sealing under the counter nonce, the deflate context, ping/pong and the dead timer; main sends and
 * receives each message as JSON by the link's number (`remote.send` and the other pushes, events `remote.message`,
 * `remote.checked`, `remote.closed`). Pushes keep the order they were sent in, so the sealing counter and both copies
 * of the deflate context follow main's order of sends.
 */
import { CORE_EXITED, core } from "../core/process";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** How long a wake's liveness check waits for any frame from the peer before it drops the link. */
export const WAKE_CHECK_MS = 3_000;

/** A message whose frame would pass `MAX_FRAME_BYTES`: nothing was sent. */
export class FrameTooLargeError extends Error {
	constructor(bytes: number) {
		super(`frame of ${bytes} bytes exceeds the 16 MiB cap`);
	}
}

/** A decoded JSON message: an object with a string `t`. */
export type WireMessage = { t: string } & Record<string, unknown>;

/** Why a link ended: the peer or the network closed it, silence, a bad frame, or this side destroyed it. */
export type LinkCloseReason = "closed" | "dead" | "protocol" | "local";

/** A link's beats, for tests: a ping every `pingMs` once it listens, dead after `deadMs` without a frame. */
export interface Liveness {
	pingMs: number;
	deadMs: number;
}

/** Sees every message the link sends (`tx`) or receives (`rx`) with its wire bytes, header and encryption overhead included. */
export type TrafficHandler = (direction: "tx" | "rx", message: object, bytes: number) => void;

interface LinkEvent {
	link: number;
}

const links = new Map<number, Link>();
let watching = false;

/** The core's link events reach the link they name. */
function watch(): void {
	if (watching) return;
	watching = true;
	const process = core();
	process.on("remote.message", (data, bin) => {
		const { link, bytes } = data as LinkEvent & { bytes?: number };
		links.get(link)?.deliver(bin ?? new Uint8Array(0), bytes);
	});
	process.on("remote.closed", data => {
		const { link, reason } = data as LinkEvent & { reason: LinkCloseReason };
		links.get(link)?.finish(reason);
	});
	process.on("remote.checked", data => links.get((data as LinkEvent).link)?.settleCheck(true));
	// A core that ends takes every link with it.
	process.on(CORE_EXITED, () => {
		for (const link of [...links.values()]) link.finish("closed");
	});
	process.on("remote.wire", data => {
		const { link, tx, bytes, t } = data as LinkEvent & { tx: boolean; bytes: number; t?: string };
		links.get(link)?.wire(tx, bytes, t);
	});
}

export class Link {
	readonly id: number;
	readonly #closeHandlers: (() => void)[] = [];
	#listener: ((message: WireMessage) => void) | null = null;
	#traffic: TrafficHandler | null = null;
	/** What this side sent while counted, waiting for the core to say its wire bytes. */
	readonly #sentQueue: object[] = [];
	#check: { promise: Promise<boolean>; resolve: (alive: boolean) => void } | null = null;
	#closed = false;
	#closeReason: LinkCloseReason | null = null;

	/** A link the core holds as `id` (an answered handshake, an opened device connection). */
	constructor(id: number) {
		this.id = id;
		watch();
		links.set(id, this);
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Why the link ended; null while it is open. */
	get closeReason(): LinkCloseReason | null {
		return this.#closeReason;
	}

	/** Send one message. Throws `FrameTooLargeError` when it exceeds the frame cap. */
	send(message: object): void {
		if (this.#closed) return;
		const json = Buffer.from(JSON.stringify(message));
		// The cap is the receiver's after inflating: a message past it is refused whatever it would deflate to.
		if (json.length > MAX_FRAME_BYTES) throw new FrameTooLargeError(json.length);
		if (this.#traffic) this.#sentQueue.push(message);
		core().push("remote.send", { link: this.id }, json);
	}

	/**
	 * Deflate large messages from now on: the peer said it reads them (its hello's `deflate`). With `context` (its
	 * hello's `deflateContext`) every message of 64 bytes or more goes deflated against the ones before it when that
	 * makes it smaller.
	 */
	deflateSent(options: { context?: boolean } = {}): void {
		if (this.#closed) return;
		core().push("remote.deflate", { link: this.id, context: options.context === true });
	}

	/** Count what crosses this link from now on (the harnesses' wire bytes); one handler. */
	onTraffic(handler: TrafficHandler): void {
		this.#traffic = handler;
		if (!this.#closed) core().push("remote.tap", { link: this.id });
	}

	/** Deliver every later message to `onMessage` and start ping/pong liveness. */
	listen(onMessage: (message: WireMessage) => void): void {
		if (this.#closed) return;
		this.#listener = onMessage;
		core().push("remote.listen", { link: this.id });
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
		this.#check = { promise, resolve };
		core().push("remote.check", { link: this.id, windowMs });
		return promise;
	}

	/** Flush what was sent, then close; destroyed if the peer does not finish within a second. */
	close(): void {
		if (this.#closed) return;
		core().push("remote.close", { link: this.id });
	}

	destroy(reason: LinkCloseReason = "local"): void {
		if (this.#closed) return;
		core().push("remote.destroy", { link: this.id, reason });
		this.finish(reason);
	}

	/** A message the core received on this link (`bytes`: its wire bytes, while counted). */
	deliver(json: Uint8Array, bytes?: number): void {
		if (this.#closed || !this.#listener) return;
		const message = JSON.parse(Buffer.from(json.buffer, json.byteOffset, json.byteLength).toString("utf8"));
		if (this.#traffic && bytes !== undefined) this.#traffic("rx", message, bytes);
		this.#listener(message as WireMessage);
	}

	/** The core's count of one frame while counted: a message this side sent, or a ping or pong of the link's own. */
	wire(tx: boolean, bytes: number, t?: string): void {
		const message = t !== undefined ? { t } : tx ? this.#sentQueue.shift() : undefined;
		if (message) this.#traffic?.(tx ? "tx" : "rx", message, bytes);
	}

	settleCheck(alive: boolean): void {
		const check = this.#check;
		if (!check) return;
		this.#check = null;
		check.resolve(alive);
	}

	finish(reason: LinkCloseReason): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#closeReason = reason;
		links.delete(this.id);
		this.settleCheck(false);
		this.#listener = null;
		for (const handler of this.#closeHandlers.splice(0)) handler();
	}
}
