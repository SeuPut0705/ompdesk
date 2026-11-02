/**
 * `window.omp`'s transport for a paired web page: the JSON frames of shared/web-protocol.ts over one WebSocket
 * to the host (design §2.2, §8).
 *
 * - Connect: a one-time ticket (`fetchTicket`), the socket opened with `ompdesk.v1` and `ticket.<token>` as its
 *   subprotocols, the host's `hello` first. A host whose `minClient` is newer than this page's protocol makes
 *   the page reload (a stale cached bundle); a 4401 close or a refused ticket means the device is unpaired.
 * - Reconnect: a dropped socket retries at once, then after 0.25, 0.5 and 1 s, then every second while the page is
 *   seen (doubling to 8 s while hidden), with a little jitter; a page coming back from sleep (`wake()`: visible,
 *   online, pageshow) retries at once, and abandons an attempt still waiting after a second: a request sent on a route
 *   that no longer exists (the phone changed networks) is never answered. An attempt gives up on its ticket after 4 s
 *   and on the host's `hello` after 5 s. The host keeps a disconnected device's window parked.
 *   A reconnect offers the last connection's id (`resume.<connId>`); the host's `hello` says `resumed` when that
 *   connection ended with every event acknowledged and no push reached the device since, and the page carries on.
 *   Otherwise events were missed (or a call the drop failed is unanswered) and the page catches up in place
 *   (`onResync`, with the cause). A host that dropped stream pushes while the page was hidden sends `hello` again on its return.
 * - Liveness: while the page is seen, 5 s without a frame from the host makes it ask (`ping`); a question left
 *   unanswered 2.5 s means the link is dead, and the page drops it and reconnects. A socket that went silent (a
 *   network change, a route that died) used to hold the page stale for up to a minute. A tick that fires late (the
 *   phone slept) asks at once instead of judging. The host pings every 20 s on its side.
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
	/** `signal` aborts when the attempt gives up on it (`ticketMs`) or a wake abandons it. */
	fetchTicket: (signal: AbortSignal) => Promise<string>;
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
	/** While the page is seen: how long without a frame from the host before it asks whether the link still works. */
	quietMs?: number;
	/** How long a question (`ping`) may go unanswered before the link counts as dead. */
	answerMs?: number;
	/** How long an attempt waits for its ticket before it gives up and tries again. */
	ticketMs?: number;
	/** How long a call waits for a link that is down before it fails. */
	connectWaitMs?: number;
	/** How long a socket may take to deliver `hello`. */
	helloMs?: number;
}

const OPEN = 1;
/** The close code the host sends a revoked device. */
const CLOSE_REVOKED = 4401;
/** Waits before the retries after a drop; past the list each wait is its last one while the page is seen. */
const RETRY_MS = [0, 250, 500, 1000] as const;
/** A hidden page has nobody waiting: its waits keep doubling up to this. */
const HIDDEN_RETRY_MAX_MS = 8000;
/** How often the link's liveness is looked at; a tick three times this late means the page was asleep. */
const LIVENESS_TICK_MS = 1000;
/** A wake abandons an attempt older than this for a fresh one. */
const STALE_ATTEMPT_MS = 1000;
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

/** One connection attempt: the ticket request and the socket that follows it. */
interface Attempt {
	readonly abort: AbortController;
	readonly startedAt: number;
}

/** `promise`, or a rejection as soon as `signal` aborts (a fake or a browser that ignores the signal still lets go). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	const { promise: aborted, reject } = Promise.withResolvers<never>();
	if (signal.aborted) reject(new Error("aborted"));
	else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	return Promise.race([promise, aborted]);
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
	readonly #quietMs: number;
	readonly #answerMs: number;
	readonly #ticketMs: number;
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
	/** Failed attempts since the last `hello`: picks the next wait. */
	#failures = 0;
	#everConnected = false;
	#started = false;
	/** The connection attempt under way, until its `hello` or its end. */
	#attempt: Attempt | null = null;
	#retryTimer: unknown = null;
	#helloTimer: unknown = null;
	#livenessTimer: unknown = null;
	#ackTimer: unknown = null;
	#lastSeq = 0;
	#ackedSeq = 0;
	#lastInbound = 0;
	#lastTick = 0;
	/** When the page asked the host whether the link works (`ping`) and has had no frame since; null otherwise. */
	#askedAt: number | null = null;
	#features: WebFeatures | null = null;
	#grants: readonly WebPermission[] | null = null;
	/** The last connection's id: a reconnect offers it (`resume.<connId>`) so the host can continue it. */
	#connId: string | null = null;
	/** A call failed when the last link dropped: the page loads its state again even if the host resumes. */
	#lostCalls = false;

	constructor(options: WsTransportOptions) {
		this.#options = options;
		this.#protocol = options.protocol ?? WEB_PROTOCOL_VERSION;
		this.#quietMs = options.quietMs ?? 5000;
		this.#answerMs = options.answerMs ?? 2500;
		this.#ticketMs = options.ticketMs ?? 4000;
		this.#connectWaitMs = options.connectWaitMs ?? 15_000;
		this.#helloMs = options.helloMs ?? 5000;
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

	/** The page came back (visible, online, pageshow): retry now, or ask whether a link that looks open still is. */
	wake(): void {
		if (!this.#started || this.#state === "unpaired" || this.#state === "outdated" || this.#state === "closed")
			return;
		if (this.#ready) {
			// Any frame answers; none within `answerMs` and the liveness tick drops the link.
			this.#ask();
			return;
		}
		const attempt = this.#attempt;
		if (attempt) {
			if (this.#now() - attempt.startedAt < STALE_ATTEMPT_MS) return;
			this.#abandonAttempt();
		}
		this.#clearTimer(this.#retryTimer);
		this.#retryTimer = null;
		this.#failures = 0;
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
		this.#abandonAttempt();
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
		if (this.#attempt || this.#ready || !this.#started) return;
		const attempt: Attempt = { abort: new AbortController(), startedAt: this.#now() };
		this.#attempt = attempt;
		const giveUp = this.#after(this.#ticketMs, () => attempt.abort.abort());
		let ticket: string;
		try {
			ticket = await untilAborted(this.#options.fetchTicket(attempt.abort.signal), attempt.abort.signal);
		} catch (error) {
			// An attempt `wake()` or `close()` abandoned is over: whatever replaced it goes on.
			if (this.#attempt !== attempt) return;
			this.#attempt = null;
			if (error instanceof UnpairedError) {
				this.#unpaired();
				return;
			}
			this.#scheduleRetry();
			return;
		} finally {
			this.#clearTimer(giveUp);
		}
		if (this.#attempt !== attempt || !this.#started) return;
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
	}

	/** Stop the attempt under way without counting it as a drop: its socket, if any, is closed unheard. */
	#abandonAttempt(): void {
		const attempt = this.#attempt;
		if (!attempt) return;
		this.#attempt = null;
		attempt.abort.abort();
		this.#clearTimer(this.#helloTimer);
		this.#helloTimer = null;
		const socket = this.#socket;
		if (!socket || this.#ready) return;
		this.#socket = null;
		try {
			socket.close(4000, "abandoned");
		} catch {
			// Already closed.
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
		this.#askedAt = null;
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
		this.#attempt = null;
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
		const resync: ResyncCause | null =
			reconnected && !frame.resumed ? "missed-events" : this.#lostCalls ? "lost-calls" : null;
		this.#lostCalls = false;
		this.#everConnected = true;
		this.#connId = frame.connId;
		this.#ready = true;
		this.#failures = 0;
		this.#features = frame.features;
		this.#grants = frame.grants;
		this.#lastSeq = 0;
		this.#ackedSeq = 0;
		this.#lastInbound = this.#now();
		this.#lastTick = this.#lastInbound;
		this.#askedAt = null;
		this.#setState("open");
		this.#startLiveness();
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

	#ask(): void {
		this.#askedAt = this.#now();
		this.#send({ t: "ping" });
	}

	#startLiveness(): void {
		this.#clearTimer(this.#livenessTimer);
		const tick = () => {
			if (!this.#ready) return;
			const now = this.#now();
			const late = now - this.#lastTick > LIVENESS_TICK_MS * 3;
			this.#lastTick = now;
			// A hidden page judges nothing (the host sends it little, and its timers are throttled); `wake()` asks on its return.
			if (this.#options.isVisible?.() ?? true) {
				if (late) {
					// The timer was starved (the phone slept): the silence says nothing yet, the answer will.
					this.#ask();
				} else if (this.#askedAt !== null && now - this.#askedAt >= this.#answerMs) {
					this.#drop(4000, "no answer");
					return;
				} else if (this.#askedAt === null && now - this.#lastInbound >= this.#quietMs) {
					this.#ask();
				}
			}
			this.#livenessTimer = this.#after(LIVENESS_TICK_MS, tick);
		};
		this.#livenessTimer = this.#after(LIVENESS_TICK_MS, tick);
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
		this.#attempt = null;
		this.#askedAt = null;
		this.#clearTimer(this.#helloTimer);
		this.#clearTimer(this.#livenessTimer);
		this.#clearTimer(this.#ackTimer);
		this.#helloTimer = this.#livenessTimer = this.#ackTimer = null;
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
		const failures = this.#failures++;
		const last = RETRY_MS[RETRY_MS.length - 1];
		const base =
			failures < RETRY_MS.length
				? RETRY_MS[failures]
				: (this.#options.isVisible?.() ?? true)
					? last
					: Math.min(HIDDEN_RETRY_MAX_MS, last * 2 ** (failures - RETRY_MS.length + 1));
		// Never longer than the base: a few devices, no herd to spread; the jitter only keeps them from lockstep.
		const jitter = 0.8 + (this.#options.random ?? Math.random)() * 0.2;
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
				// What it asked for was never read: the page reads its state again once the link is up, even on its first
				// connection (a page loaded during an outage failed its boot reads this way).
				this.#lostCalls = true;
				fail(new Error(translate("web.call.unreachable")));
			}),
		};
		this.#waiting.add(entry);
	}
}
