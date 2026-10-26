/**
 * `window.omp`'s transport for a paired web page: the JSON frames of shared/web-protocol.ts over one WebSocket
 * to the host (design §2.2, §8).
 *
 * - Connect: a one-time ticket (`fetchTicket`), the socket opened with `ompdesk.v1` and `ticket.<token>` as its
 *   subprotocols, the host's `hello` first. A host whose `minClient` is newer than this page's protocol makes
 *   the page reload (a stale cached bundle); a 4401 close or a refused ticket means the device is unpaired.
 * - Reconnect: a dropped socket retries after 0.5 s doubling to 8 s with jitter; a page coming back from sleep
 *   (`wake()`: visible, online, pageshow) retries at once. The host keeps a disconnected device's window parked.
 *   A reconnect offers the last connection's id (`resume.<connId>`); the host's `hello` says `resumed` when that
 *   connection ended with every event acknowledged and no push reached the device since, and the page carries on.
 *   Otherwise events were missed (or a call the drop failed is unanswered) and the page catches up in place
 *   (`onResync`, with the cause). A host that dropped stream pushes while the page was hidden sends `hello` again on its return.
 * - Liveness: the host pings every 20 s; the page declares the link dead only after three silent intervals, and a
 *   tick that fires late (the phone slept) counts for nothing.
 * - Acks: the last event `seq` applied goes back, coalesced; the host resumes only a connection fully acknowledged.
 * - Calls made while the link is down wait for it (up to `connectWaitMs`); calls in flight when it drops fail.
 */
import type { OmpTransport } from "../../shared/omp-api";
import type { WebClientFrame, WebFeatures, WebPermission, WebServerFrame } from "../../shared/web-protocol";
import { WEB_PROTOCOL_VERSION } from "../../shared/web-protocol";
import { translate } from "../lib/i18n";
import { UnpairedError } from "./session";

export type WsConnectionState =
	/** The first connection is being made. */
	| "connecting"
	| "open"
	/** The link dropped; retrying. */
	| "reconnecting"
	/** The host no longer knows this device; pairing is needed. */
	| "unpaired"
	/** The host needs a newer page than this one. */
	| "outdated"
	| "closed";

/** Why a reconnect needs the page to load its state again (`onResync`). */
export type ResyncCause = "missed-events" | "lost-calls";

/** The part of the browser `WebSocket` the transport uses. */
export interface WsLike {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number }) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

export interface WsTransportOptions {
	url: string;
	fetchTicket: () => Promise<string>;
	createSocket: (url: string, protocols: string[]) => WsLike;
	/** The page's protocol version; defaults to this build's. */
	protocol?: number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	now?: () => number;
	random?: () => number;
	/** The page is visible (presence frames and the first one after connecting). */
	isVisible?: () => boolean;
	/** The host named a newer minimum client: the page is stale. */
	onOutdated?: () => void;
	/**
	 * The link came back after a drop and the page must load its state again: `missed-events` when the host could not
	 * resume the last connection (events were dropped, or it restarted), `lost-calls` when it did but a call the drop
	 * failed is unanswered.
	 */
	onResync?: (cause: ResyncCause) => void;
	/** No pairing for this browser. */
	onUnpaired?: () => void;
	heartbeatMs?: number;
	heartbeatMisses?: number;
	/** How long a call waits for a link that is down before it fails. */
	connectWaitMs?: number;
	/** How long a socket may take to deliver `hello`. */
	helloMs?: number;
}

const OPEN = 1;
/** The close code the host sends a revoked device. */
const CLOSE_REVOKED = 4401;
const BACKOFF_FIRST_MS = 500;
const BACKOFF_MAX_MS = 8000;
const ACK_DELAY_MS = 150;
/** The host's frame limit; a bigger request fails here with a reason instead of closing the socket. */
const MAX_FRAME_BYTES = 1_000_000;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface Waiting {
	run: () => void;
	fail: (error: Error) => void;
	timer: unknown;
}

/** An error the way Electron's `invoke` rejection carries a code: `[code] message`. */
function hostError(error: { message: string; code?: string }): Error {
	return new Error(error.code ? `[${error.code}] ${error.message}` : error.message);
}

function byteLength(text: string): number {
	return text.length > MAX_FRAME_BYTES / 4 ? new TextEncoder().encode(text).byteLength : text.length;
}

function isServerFrame(value: unknown): value is WebServerFrame {
	return typeof value === "object" && value !== null && "t" in value && typeof value.t === "string";
}

export class WsTransport implements OmpTransport {
	readonly #options: WsTransportOptions;
	readonly #protocol: number;
	readonly #heartbeatMs: number;
	readonly #heartbeatMisses: number;
	readonly #connectWaitMs: number;
	readonly #helloMs: number;
	readonly #listeners = new Map<string, Set<(data: unknown) => void>>();
	readonly #stateListeners = new Set<(state: WsConnectionState) => void>();
	readonly #pending = new Map<number, Pending>();
	readonly #waiting = new Set<Waiting>();

	#state: WsConnectionState = "closed";
	#socket: WsLike | null = null;
	/** The socket is open and the host's `hello` arrived. */
	#ready = false;
	#nextId = 1;
	#attempt = 0;
	#everConnected = false;
	#started = false;
	#connecting = false;
	#retryTimer: unknown = null;
	#helloTimer: unknown = null;
	#heartbeatTimer: unknown = null;
	#ackTimer: unknown = null;
	#lastSeq = 0;
	#ackedSeq = 0;
	#lastInbound = 0;
	#lastTick = 0;
	#misses = 0;
	/** Frames received on this page so far; the wake probe compares it before and after. */
	#inbound = 0;
	#features: WebFeatures | null = null;
	#grants: readonly WebPermission[] | null = null;
	/** The last connection's id: a reconnect offers it (`resume.<connId>`) so the host can continue it. */
	#connId: string | null = null;
	/** A call failed when the last link dropped: the page loads its state again even if the host resumes. */
	#lostCalls = false;

	constructor(options: WsTransportOptions) {
		this.#options = options;
		this.#protocol = options.protocol ?? WEB_PROTOCOL_VERSION;
		this.#heartbeatMs = options.heartbeatMs ?? 20_000;
		this.#heartbeatMisses = options.heartbeatMisses ?? 3;
		this.#connectWaitMs = options.connectWaitMs ?? 15_000;
		this.#helloMs = options.helloMs ?? 10_000;
	}

	get state(): WsConnectionState {
		return this.#state;
	}

	/** What the host offered in its last `hello`. */
	get features(): WebFeatures | null {
		return this.#features;
	}

	/** What the host's last `hello` said this device may call. */
	get grants(): readonly WebPermission[] | null {
		return this.#grants;
	}

	onState(listener: (state: WsConnectionState) => void): () => void {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	/** Begin connecting; safe to call twice. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#setState("connecting");
		void this.#connect();
	}

	/** The page came back (visible, online, pageshow): retry now, or check that a link that looks open still is. */
	wake(): void {
		if (!this.#started || this.#state === "unpaired" || this.#state === "outdated" || this.#state === "closed")
			return;
		if (this.#ready) {
			this.#send({ t: "ping" });
			// The probe's answer is any inbound frame; none within a few seconds means the phone's link died asleep.
			const before = this.#inbound;
			this.#after(5000, () => {
				if (this.#ready && this.#inbound === before) this.#drop(4000, "no answer after wake");
			});
			return;
		}
		if (this.#connecting) return;
		this.#clearTimer(this.#retryTimer);
		this.#retryTimer = null;
		this.#attempt = 0;
		void this.#connect();
	}

	/** Tell the host whether the page is visible (it stops full streams for a hidden one). */
	setPresence(visible: boolean): void {
		this.#send({ t: "presence", visible });
	}

	/** Stop for good (tests, page teardown). */
	close(): void {
		this.#started = false;
		this.#clearTimer(this.#retryTimer);
		this.#retryTimer = null;
		this.#setState("closed");
		this.#drop(1000, "closed");
	}

	invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				const id = this.#nextId++;
				const frame: WebClientFrame = { t: "inv", id, ch: channel, a: args };
				let text: string;
				try {
					text = JSON.stringify(frame);
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				if (byteLength(text) > MAX_FRAME_BYTES) {
					reject(new Error(translate("web.call.tooLarge")));
					return;
				}
				this.#pending.set(id, { resolve: value => resolve(value as T), reject });
				this.#socket?.send(text);
			};
			if (this.#ready) run();
			else this.#wait(run, reject);
		});
	}

	send(channel: string, ...args: unknown[]): void {
		this.#send({ t: "snd", ch: channel, a: args });
	}

	on(channel: string, listener: (data: unknown) => void): () => void {
		let set = this.#listeners.get(channel);
		if (!set) {
			set = new Set();
			this.#listeners.set(channel, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	}

	// --- connection ---------------------------------------------------------------------------------

	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	#after(ms: number, callback: () => void): unknown {
		return (this.#options.setTimer ?? ((cb, delay) => setTimeout(cb, delay)))(callback, ms);
	}

	#clearTimer(handle: unknown): void {
		if (handle === null || handle === undefined) return;
		(this.#options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
	}

	#setState(state: WsConnectionState): void {
		if (this.#state === state) return;
		this.#state = state;
		for (const listener of this.#stateListeners) listener(state);
	}

	async #connect(): Promise<void> {
		if (this.#connecting || this.#ready || !this.#started) return;
		this.#connecting = true;
		try {
			const ticket = await this.#options.fetchTicket();
			if (!this.#started) return;
			const protocols = ["ompdesk.v1", `ticket.${ticket}`];
			if (this.#everConnected && this.#connId) protocols.push(`resume.${this.#connId}`);
			const socket = this.#options.createSocket(this.#options.url, protocols);
			this.#socket = socket;
			socket.onmessage = event => {
				if (this.#socket === socket) this.#receive(event.data);
			};
			socket.onclose = event => {
				if (this.#socket === socket) this.#closed(event.code);
			};
			socket.onerror = () => {
				// `close` follows with the code.
			};
			this.#helloTimer = this.#after(this.#helloMs, () => {
				if (this.#socket === socket && !this.#ready) this.#drop(4001, "no hello");
			});
		} catch (error) {
			this.#connecting = false;
			if (error instanceof UnpairedError) {
				this.#unpaired();
				return;
			}
			this.#scheduleRetry();
		}
	}

	#receive(data: unknown): void {
		if (typeof data !== "string") return;
		let frame: unknown;
		try {
			frame = JSON.parse(data);
		} catch {
			return;
		}
		if (!isServerFrame(frame)) return;
		this.#lastInbound = this.#now();
		this.#inbound++;
		this.#misses = 0;
		switch (frame.t) {
			case "hello":
				this.#hello(frame);
				return;
			case "ping":
				this.#send({ t: "pong" });
				return;
			case "pong":
				return;
			case "res": {
				const pending = this.#pending.get(frame.id);
				if (!pending) return;
				this.#pending.delete(frame.id);
				if (frame.ok) pending.resolve(frame.v);
				else pending.reject(hostError(frame.e));
				return;
			}
			case "evt":
				this.#event(frame.seq, frame.ch, frame.d);
				return;
		}
	}

	#hello(frame: Extract<WebServerFrame, { t: "hello" }>): void {
		this.#clearTimer(this.#helloTimer);
		this.#helloTimer = null;
		this.#connecting = false;
		if (frame.minClient > this.#protocol) {
			this.#setState("outdated");
			this.#started = false;
			this.#drop(1000, "outdated");
			this.#options.onOutdated?.();
			return;
		}
		const reconnected = this.#everConnected;
		// The host resumes a connection only when this page had every event; a call the drop failed still
		// left something unanswered, so the page loads its state again then.
		const resync: ResyncCause | null = !reconnected
			? null
			: !frame.resumed
				? "missed-events"
				: this.#lostCalls
					? "lost-calls"
					: null;
		this.#lostCalls = false;
		this.#everConnected = true;
		this.#connId = frame.connId;
		this.#ready = true;
		this.#attempt = 0;
		this.#features = frame.features;
		this.#grants = frame.grants;
		this.#lastSeq = 0;
		this.#ackedSeq = 0;
		this.#lastInbound = this.#now();
		this.#lastTick = this.#lastInbound;
		this.#setState("open");
		this.#startHeartbeat();
		this.#send({ t: "presence", visible: this.#options.isVisible?.() ?? true });
		const waiting = [...this.#waiting];
		this.#waiting.clear();
		for (const entry of waiting) {
			this.#clearTimer(entry.timer);
			entry.run();
		}
		if (resync) this.#options.onResync?.(resync);
	}

	#event(seq: number, channel: string, data: unknown): void {
		if (seq > this.#lastSeq) this.#lastSeq = seq;
		const listeners = this.#listeners.get(channel);
		if (listeners) for (const listener of [...listeners]) listener(data);
		if (this.#ackTimer === null) {
			this.#ackTimer = this.#after(ACK_DELAY_MS, () => {
				this.#ackTimer = null;
				if (this.#lastSeq > this.#ackedSeq) {
					this.#ackedSeq = this.#lastSeq;
					this.#send({ t: "ack", seq: this.#lastSeq });
				}
			});
		}
	}

	#send(frame: WebClientFrame): void {
		if (!this.#ready || this.#socket?.readyState !== OPEN) return;
		this.#socket.send(JSON.stringify(frame));
	}

	#startHeartbeat(): void {
		this.#clearTimer(this.#heartbeatTimer);
		const tick = () => {
			if (!this.#ready) return;
			const now = this.#now();
			const late = now - this.#lastTick > this.#heartbeatMs * 1.5;
			this.#lastTick = now;
			if (late) {
				// The timer was starved (the phone slept): the silence says nothing about the link.
				this.#misses = 0;
			} else if (now - this.#lastInbound >= this.#heartbeatMs) {
				this.#misses++;
				if (this.#misses >= this.#heartbeatMisses) {
					this.#drop(4000, "heartbeat");
					return;
				}
			}
			this.#send({ t: "ping" });
			this.#heartbeatTimer = this.#after(this.#heartbeatMs, tick);
		};
		this.#heartbeatTimer = this.#after(this.#heartbeatMs, tick);
	}

	/** Close the current socket from this side and treat it as dropped. */
	#drop(code: number, reason: string): void {
		const socket = this.#socket;
		if (!socket) return;
		this.#socket = null;
		try {
			socket.close(code, reason);
		} catch {
			// Already closed.
		}
		this.#ended(code);
	}

	#closed(code: number): void {
		this.#socket = null;
		this.#ended(code);
	}

	#ended(code: number): void {
		this.#ready = false;
		this.#connecting = false;
		this.#clearTimer(this.#helloTimer);
		this.#clearTimer(this.#heartbeatTimer);
		this.#clearTimer(this.#ackTimer);
		this.#helloTimer = this.#heartbeatTimer = this.#ackTimer = null;
		if (this.#pending.size > 0) this.#lostCalls = true;
		for (const pending of this.#pending.values()) pending.reject(new Error(translate("web.call.dropped")));
		this.#pending.clear();
		if (code === CLOSE_REVOKED) {
			this.#unpaired();
			return;
		}
		if (!this.#started) return;
		this.#scheduleRetry();
	}

	#unpaired(): void {
		this.#started = false;
		this.#setState("unpaired");
		const error = new UnpairedError();
		for (const entry of [...this.#waiting]) {
			this.#clearTimer(entry.timer);
			entry.fail(error);
		}
		this.#waiting.clear();
		this.#options.onUnpaired?.();
	}

	#scheduleRetry(): void {
		this.#setState(this.#everConnected ? "reconnecting" : "connecting");
		const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** this.#attempt);
		this.#attempt++;
		const jitter = 0.75 + (this.#options.random ?? Math.random)() * 0.5;
		this.#retryTimer = this.#after(Math.round(base * jitter), () => {
			this.#retryTimer = null;
			void this.#connect();
		});
	}

	#wait(run: () => void, fail: (error: Error) => void): void {
		if (this.#state === "unpaired" || this.#state === "outdated" || this.#state === "closed") {
			fail(new Error(translate(this.#state === "unpaired" ? "web.call.unpaired" : "web.call.closed")));
			return;
		}
		const entry: Waiting = {
			run,
			fail,
			timer: this.#after(this.#connectWaitMs, () => {
				this.#waiting.delete(entry);
				fail(new Error(translate("web.call.unreachable")));
			}),
		};
		this.#waiting.add(entry);
	}
}
