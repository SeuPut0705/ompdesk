/**
 * The client side (A) of remote devices. `probeHost` asks an address whether an OMPdesk host answers there and
 * lets this device in (it shows the host before any connection); `connectFirst` runs the handshake once with a
 * host this device never connected to and pins the host's key; a `RemoteClient` per known host keeps one
 * authenticated link up (reconnecting with 1 s → 30 s backoff over the host's current addresses) and carries
 * requests and pushed events. The dial, the probe and the handshake run in the core (`crates/core/src/remote`);
 * the reconnect loop and every request on the link are main's.
 */
import { EventEmitter } from "node:events";
import { core } from "../core/process";
import type { HostHello } from "./host-server";
import type { HostStore, PairedHost } from "./hosts-store";
import type { Identity } from "./identity";
import { type TabHolder, tabHolderOf, WireEvent, WireResponse } from "./protocol";
import { Link, type Liveness, WAKE_CHECK_MS, type WireMessage } from "./wire";

export type LinkState = "connecting" | "online" | "offline";

/** What may say the network or the computer changed: the client checks (online) or retries (offline) at once. */
/**
 * What may say the network or the computer changed: the client checks (online) or retries (offline) at once.
 * `peer`: the host's computer just connected to this one, so it is up now, even while a dial to it still hangs.
 */
export type WakeTrigger = "resume" | "unlock" | "online" | "tailnet" | "focus" | "peer";

type AttemptTrigger = "start" | "connect" | "backoff" | WakeTrigger;

/** Backoff retries past this one (30 s apart by then) are not logged: an absent host would fill the log. */
const LOGGED_BACKOFF_ATTEMPTS = 6;

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/**
 * A dial the host's computer refuses (nothing listens: its app is restarting or updating; the Windows host's log
 * shows 21 s to app-ready and 26 s to the bridge per update) is retried every `RECONNECT_MIN_MS` this long after
 * the link was lost, then backs off like any other failure. A refusal is one cheap round trip.
 */
export const REFUSED_RETRY_WINDOW_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** An address step older than this when the host's computer connects here is stuck, not slow: a live host answers in tens of ms. */
const STALE_STEP_MS = 1_000;

/**
 * A remote failure with a stable code: the host's refusal (`REFUSAL_CODES` in protocol.ts), this side's
 * (`key_mismatch` for a host that answers with another key, `unreachable`, `protocol`), links (`remote_offline`,
 * `timeout`, `too_large`), or whatever code the host's handler failed with.
 */
export class RemoteError extends Error {
	readonly code: string;
	/** The dial was refused or reset: the computer answered and nothing listens (not a timeout or no route). */
	readonly refused: boolean;
	/** `session_open_in_tab`: the tab that holds the session, when the host named it (`TabHolder`). */
	readonly holder: TabHolder | undefined;

	constructor(code: string, message: string = code, refused = false, holder?: TabHolder) {
		super(message);
		this.name = "RemoteError";
		this.code = code;
		this.refused = refused;
		this.holder = holder;
	}
}

/**
 * What this device can read beyond whole frames, sent in its hello (`ClientHello`, protocol.ts): every capability
 * this build has. An older host ignores the ones it does not know.
 */
const HELLO_CAPABILITIES = {
	slimEvents: true,
	slimProgress: true,
	slimAutopilot: true,
	slimEnds: true,
	slimReadGroups: true,
	slimToolResults: true,
	slimEndFields: true,
	slimAutopilotReads: true,
	slimListReads: true,
	slimShiftedReads: true,
	slimSettingsReads: true,
	slimRosterReads: true,
	slimJobsReads: true,
	slimToolOutputs: true,
	slimToolArgs: true,
	deflate: true,
	deflateContext: true,
	slimSessionLists: true,
};

/** A failure the core answered for a dial, a probe or a handshake. */
interface Failed {
	failed: { code: string; message: string; refused: boolean };
}

function failure(answer: Failed): RemoteError {
	return new RemoteError(answer.failed.code, answer.failed.message, answer.failed.refused);
}

/** RemoteErrors pass through; anything else (the core gone, a timeout) means the host is out of reach. */
function asRemoteError(error: unknown): RemoteError {
	if (error instanceof RemoteError) return error;
	return new RemoteError("unreachable", error instanceof Error ? error.message : String(error));
}

/** A dial to a port no answer has come from yet starts this long after the one before it (or as soon as that one fails). */
export const DIAL_STAGGER_MS = 250;

/**
 * The first of `addresses` (a host's candidate ports, best first) whose TCP connect succeeds, dialed by the core
 * `DIAL_STAGGER_MS` apart. Rejects `unreachable` once every one failed, `refused` when every one was refused (the
 * computer is up and nothing listens). The socket waits in the core for its handshake.
 */
async function firstToConnect(
	addresses: readonly string[],
	signal?: AbortSignal,
): Promise<{ address: string; conn: number }> {
	const { result } = await core()
		.call<Failed | { address: string; conn: number }>("remote.connect", { addresses }, { signal, timeoutMs: 60_000 })
		.catch(error => {
			throw asRemoteError(error);
		});
	if ("failed" in result) throw failure(result);
	return result;
}

/** What a probe found at an address: a host that lets this device in, or one that refuses it (and why). */
export type ProbeResult =
	| { ok: true; deviceId: string; name: string; appVersion: string }
	| { ok: false; code: string };

/**
 * Ask `address` whether an OMPdesk host answers and would let this device in. Throws RemoteError `unreachable`
 * when nothing (or something else) answers there.
 */
export async function probeHost(address: string): Promise<ProbeResult> {
	const { result } = await core()
		.call<Failed | { probe: ProbeResult }>("remote.probeHost", { address })
		.catch(error => {
			throw asRemoteError(error);
		});
	if ("failed" in result) throw failure(result);
	return result.probe;
}

/**
 * Where a computer's host answers: the first of `addresses` that connects and answers a probe from another device
 * than `skip` (this computer itself, in a test's two apps on one address). `address` null: none did; `probe` then
 * holds the last refusal heard, else `unreachable`.
 */
export async function probeAny(
	addresses: readonly string[],
	skip?: string,
): Promise<{ address: string | null; probe: ProbeResult }> {
	const { result } = await core().call<{ address: string | null; probe: ProbeResult }>(
		"remote.probe",
		{ addresses, skip },
		{ timeoutMs: 60_000 + addresses.length * 6_000 },
	);
	return result;
}

interface HandshakeOptions {
	identity: Identity;
	name: string;
	appVersion: string;
	/** The host this device pinned: its id and key must answer. Null on first contact (the key is pinned then). */
	expected: { deviceId: string; staticPub: string } | null;
	/** Ends the handshake under way (`unreachable`). */
	signal?: AbortSignal;
	liveness?: Liveness;
}

interface Handshake {
	link: Link;
	hello: HostHello;
	host: { deviceId: string; name: string; staticPub: string };
}

/**
 * Auth, client side, on a socket the core connected: both static and both ephemeral keys go into the session keys
 * (DH(eA,eB) ‖ DH(sA,eB) ‖ DH(eA,sB)), so only the holder of the host key this device pinned can read or answer the
 * link. The link delivers nothing until `listen`.
 */
async function handshakeOn(address: string, conn: number, opts: HandshakeOptions): Promise<Handshake> {
	const params = {
		identity: opts.identity.deviceId,
		conn,
		address,
		expected: opts.expected,
		name: opts.name,
		appVersion: opts.appVersion,
		capabilities: HELLO_CAPABILITIES,
		...(opts.liveness ? { liveness: opts.liveness } : {}),
	};
	const { result } = await core()
		.call<Failed | { link: number; hello: HostHello; host: Handshake["host"] }>("remote.handshake", params, {
			signal: opts.signal,
		})
		.catch(error => {
			throw asRemoteError(error);
		});
	if ("failed" in result) throw failure(result);
	return { link: new Link(result.link), hello: result.hello, host: result.host };
}

export interface FirstContactOptions {
	identity: Identity;
	address: string;
	name: string;
	appVersion: string;
	/** The host's Tailscale node, recorded with it. */
	nodeId: string;
	hosts: HostStore;
}

/**
 * Connect once to a host this device never connected to, pin its key and node, and record it. A host already
 * pinned to that node must answer with the same id and key (`key_mismatch` otherwise).
 */
export async function connectFirst(opts: FirstContactOptions): Promise<PairedHost> {
	const pinned = opts.hosts.byNode(opts.nodeId);
	const { conn } = await firstToConnect([opts.address]);
	const { link, host } = await handshakeOn(opts.address, conn, {
		identity: opts.identity,
		name: opts.name,
		appVersion: opts.appVersion,
		expected: pinned ? { deviceId: pinned.deviceId, staticPub: pinned.staticPub } : null,
	});
	link.close();
	const previous = opts.hosts.get(host.deviceId);
	if (previous && previous.staticPub !== host.staticPub) {
		throw new RemoteError("key_mismatch", `${host.name} answers with another key than the one pinned`);
	}
	const record: PairedHost = {
		deviceId: host.deviceId,
		name: host.name,
		staticPub: host.staticPub,
		nodeId: opts.nodeId,
		addresses: [opts.address, ...(previous?.addresses.filter(a => a !== opts.address) ?? [])],
		pairedAt: previous?.pairedAt ?? Date.now(),
	};
	opts.hosts.put(record);
	return opts.hosts.get(record.deviceId) ?? record;
}

export interface RemoteClientOptions {
	identity: Identity;
	host: PairedHost;
	appVersion: string;
	name: () => string;
	/** Read the pinned record from here on every attempt, and record the working address and the host's name. */
	hosts?: HostStore;
	/** Where the host can be reached now (its node's tailnet address first); the stored addresses when omitted. */
	addresses?: (host: PairedHost) => Promise<string[]>;
	/** The link's transitions for the runtime log (`remote-link`): `down`, each `attempt`, `up`. No addresses or keys. */
	log?: (event: "down" | "attempt" | "up", details: Record<string, unknown>) => void;
	/** The link's ping and dead timers (tests shorten them). */
	liveness?: Liveness;
}

/** One stretch without a link: from the drop (or the first attempt of a launch) until it is online again. */
interface Outage {
	since: number;
	attempts: number;
	downLogged: boolean;
	/** Whether the last failed attempt of this stretch was refused on every address; null before one failed. */
	refused: boolean | null;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: RemoteError) => void;
	timer: NodeJS.Timeout;
}

/** One known host's link; auto-reconnects with backoff 1 s → 30 s between rounds of its addresses. */
export class RemoteClient {
	readonly deviceId: string;
	readonly #opts: RemoteClientOptions;
	readonly #emitter = new EventEmitter();
	readonly #pending = new Map<number, Pending>();
	#host: PairedHost;
	#state: LinkState = "offline";
	#hello: HostHello | null = null;
	#error: string | null = null;
	#link: Link | null = null;
	#running = false;
	#attempting = false;
	/** Ends the attempt under way when the host's computer shows it is up; `#rerun` then names the next one. */
	#cancel: AbortController | null = null;
	#rerun: WakeTrigger | null = null;
	/** The address step under way: when it began, and a count that tells it from the next one. */
	#stepAt = 0;
	#step = 0;
	#staleTimer: NodeJS.Timeout | undefined;
	#retryTimer: NodeJS.Timeout | undefined;
	#backoff = RECONNECT_MIN_MS;
	#onlineAt: number | null = null;
	#outage: Outage | null = null;
	#nextId = 1;

	constructor(opts: RemoteClientOptions) {
		this.#opts = opts;
		this.#host = { ...opts.host, addresses: [...opts.host.addresses] };
		this.deviceId = opts.host.deviceId;
	}

	get state(): LinkState {
		return this.#state;
	}

	/** The last hello from the host; kept while offline. */
	get hello(): HostHello | null {
		return this.#hello;
	}

	/** Why the last attempt failed (`unreachable`, a refusal code, `key_mismatch`, `protocol`); null once online. */
	get error(): string | null {
		return this.#error;
	}

	get host(): PairedHost {
		return { ...this.#host, addresses: [...this.#host.addresses] };
	}

	/** The host announced a new name (`host.name`): show and remember it. */
	hostRenamed(name: string): void {
		this.#host.name = name;
		if (this.#hello) this.#hello = { ...this.#hello, name };
		const hosts = this.#opts.hosts;
		if (hosts && hosts.get(this.deviceId)?.name !== name) hosts.update(this.deviceId, { name });
	}

	/** Start (or keep) the link; while waiting out a backoff, retry now. */
	connect(): void {
		this.#running = true;
		if (this.#link || this.#attempting) return;
		const trigger = this.#retryTimer ? "connect" : "start";
		this.#clearRetry();
		void this.#attempt(trigger, 0);
	}

	/**
	 * The network or the computer may have changed under the link (wake from sleep, unlock, the network back, a
	 * window in front, the tailnet's node of the host back). Offline or waiting out a backoff: start over from a 1 s
	 * backoff and try now. Online: send a ping and drop the link if nothing answers within `WAKE_CHECK_MS`, then try
	 * now, instead of waiting for the 30 s dead timer. An attempt already running is the one that is trying now,
	 * except on `peer`: the host's computer connected to this one, so a dial that has waited on an address for
	 * `STALE_STEP_MS` (a restarting host's ports time out, 5 s each) is ended and tried again at once. A younger one
	 * is left to finish (a live host answers in tens of ms): both computers reconnecting to each other at once would
	 * otherwise end each other's handshakes over and over.
	 */
	wake(trigger: WakeTrigger): void {
		if (!this.#running) return;
		if (this.#attempting) {
			if (trigger === "peer") this.#cancelStale(this.#step);
			return;
		}
		const link = this.#link;
		if (!link) {
			this.#retryNow(trigger);
			return;
		}
		void link.check(WAKE_CHECK_MS).then(alive => {
			if (!alive) this.#retryNow(trigger);
		});
	}

	/** Stop reconnecting and drop the link; pending requests reject `remote_offline`. */
	close(): void {
		clearTimeout(this.#staleTimer);
		this.#running = false;
		this.#clearRetry();
		this.#link?.destroy();
		this.#setState("offline");
	}

	/** Rejects RemoteError `remote_offline` unless online, `timeout` after `timeoutMs`. */
	request<T>(method: string, params: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
		const link = this.#link;
		if (!link || this.#state !== "online") {
			return Promise.reject(new RemoteError("remote_offline", `${this.#host.name} is offline`));
		}
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new RemoteError("timeout", `${method} timed out after ${timeoutMs} ms`));
		}, timeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		try {
			link.send({ t: "req", id, method, params });
		} catch (error) {
			clearTimeout(timer);
			this.#pending.delete(id);
			reject(new RemoteError("too_large", error instanceof Error ? error.message : String(error)));
		}
		return promise as Promise<T>;
	}

	on(event: "state", fn: (state: LinkState) => void): void;
	on(event: "event", fn: (event: string, data: unknown) => void): void;
	on(event: "state" | "event", fn: ((state: LinkState) => void) | ((event: string, data: unknown) => void)): void {
		this.#emitter.on(event, fn);
	}

	off(event: "state", fn: (state: LinkState) => void): void;
	off(event: "event", fn: (event: string, data: unknown) => void): void;
	off(event: "state" | "event", fn: ((state: LinkState) => void) | ((event: string, data: unknown) => void)): void {
		this.#emitter.off(event, fn);
	}

	#setState(state: LinkState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#emitter.emit("state", state);
	}

	/** The resolver's answer when there is one (it decides whether stored addresses count), else the stored ones. */
	async #addresses(): Promise<string[]> {
		const stored = this.#opts.hosts?.get(this.deviceId) ?? this.#host;
		if (!this.#opts.addresses) return stored.addresses;
		return this.#opts.addresses(stored).catch(() => []);
	}

	async #attempt(trigger: AttemptTrigger, delayMs: number): Promise<void> {
		this.#attempting = true;
		this.#outage ??= { since: Date.now(), attempts: 0, downLogged: false, refused: null };
		const outage = this.#outage;
		outage.attempts += 1;
		if (trigger !== "backoff" || outage.attempts <= LOGGED_BACKOFF_ATTEMPTS) {
			const last = outage.refused === null ? {} : { refused: outage.refused };
			this.#opts.log?.("attempt", { deviceId: this.deviceId, n: outage.attempts, delayMs, trigger, ...last });
		}
		this.#setState("connecting");
		const cancel = new AbortController();
		this.#cancel = cancel;
		const addresses = await this.#addresses();
		let failure = new RemoteError("unreachable", "no address to dial");
		// Every address refused: the computer is there and the app is not (a timeout anywhere says otherwise).
		let refused = addresses.length > 0;
		let remaining = addresses;
		while (remaining.length > 0) {
			if (!this.#running || cancel.signal.aborted) break;
			this.#step += 1;
			this.#stepAt = Date.now();
			let connected: { address: string; conn: number };
			try {
				connected = await firstToConnect(remaining, cancel.signal);
			} catch (error) {
				failure = asRemoteError(error);
				refused &&= failure.refused;
				break;
			}
			const address = connected.address;
			remaining = remaining.filter(other => other !== address);
			// Something listens there: the attempt was not refused everywhere.
			refused = false;
			try {
				const { link, hello } = await handshakeOn(address, connected.conn, {
					identity: this.#opts.identity,
					name: this.#opts.name(),
					appVersion: this.#opts.appVersion,
					expected: { deviceId: this.deviceId, staticPub: this.#host.staticPub },
					signal: cancel.signal,
					liveness: this.#opts.liveness,
				});
				if (!this.#running) {
					link.destroy();
					break;
				}
				this.#attempting = false;
				this.#cancel = null;
				this.#rerun = null;
				this.#online(link, hello, address);
				return;
			} catch (error) {
				failure = asRemoteError(error);
				// The host itself answered: other addresses reach the same verdict.
				if (failure.code !== "unreachable") break;
			}
		}
		this.#attempting = false;
		this.#cancel = null;
		if (!this.#running) return;
		const rerun = this.#rerun;
		this.#rerun = null;
		if (rerun) {
			this.#retryNow(rerun);
			return;
		}
		this.#error = failure.code;
		outage.refused = refused;
		if (!outage.downLogged) {
			outage.downLogged = true;
			this.#opts.log?.("down", {
				deviceId: this.deviceId,
				name: this.#host.name,
				reason: failure.code,
				wasOnlineMs: 0,
			});
		}
		this.#setState("offline");
		this.#scheduleRetry(refused && Date.now() - outage.since < REFUSED_RETRY_WINDOW_MS);
	}

	#online(link: Link, hello: HostHello, address: string): void {
		const now = Date.now();
		const outage = this.#outage;
		this.#outage = null;
		this.#onlineAt = now;
		if (outage) {
			// The host's build beside it: a link that misbehaves after one side updated is read from either log.
			this.#opts.log?.("up", {
				deviceId: this.deviceId,
				outageMs: now - outage.since,
				attempts: outage.attempts,
				appVersion: hello.appVersion,
			});
		}
		this.#link = link;
		this.#hello = hello;
		this.#error = null;
		this.#backoff = RECONNECT_MIN_MS;
		this.#host.addresses = [address, ...this.#host.addresses.filter(a => a !== address)];
		this.#host.name = hello.name;
		const hosts = this.#opts.hosts;
		if (hosts) {
			hosts.rememberAddress(this.deviceId, address);
			if (hosts.get(this.deviceId)?.name !== hello.name) hosts.update(this.deviceId, { name: hello.name });
		}
		link.onClose(() => this.#dropped(link));
		link.listen(message => this.#onMessage(message));
		this.#setState("online");
	}

	#dropped(link: Link): void {
		if (this.#link !== link) return;
		this.#link = null;
		const now = Date.now();
		this.#opts.log?.("down", {
			deviceId: this.deviceId,
			name: this.#host.name,
			reason: link.closeReason ?? "closed",
			wasOnlineMs: now - (this.#onlineAt ?? now),
		});
		this.#outage = { since: now, attempts: 0, downLogged: true, refused: null };
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			pending.reject(new RemoteError("remote_offline", `${this.#host.name} went offline`));
		}
		this.#setState("offline");
		this.#scheduleRetry();
	}

	/** `refused`: the host's computer answered with a refusal, so the backoff stays at its first step instead of growing. */
	#scheduleRetry(refused = false): void {
		if (!this.#running) return;
		if (refused) this.#backoff = RECONNECT_MIN_MS;
		const delay = this.#backoff;
		this.#backoff = refused ? RECONNECT_MIN_MS : Math.min(this.#backoff * 2, RECONNECT_MAX_MS);
		clearTimeout(this.#retryTimer);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			void this.#attempt("backoff", delay);
		}, delay);
	}

	#clearRetry(): void {
		clearTimeout(this.#retryTimer);
		this.#retryTimer = undefined;
	}

	/** End address step `step` once it has run `STALE_STEP_MS`, unless it ended first. */
	#cancelStale(step: number): void {
		clearTimeout(this.#staleTimer);
		if (!this.#attempting || this.#step !== step || !this.#cancel) return;
		const left = this.#stepAt + STALE_STEP_MS - Date.now();
		if (left > 0) {
			this.#staleTimer = setTimeout(() => this.#cancelStale(step), left);
			this.#staleTimer.unref?.();
			return;
		}
		this.#rerun = "peer";
		this.#cancel.abort();
	}

	#retryNow(trigger: WakeTrigger): void {
		if (!this.#running || this.#link || this.#attempting) return;
		this.#clearRetry();
		this.#backoff = RECONNECT_MIN_MS;
		void this.#attempt(trigger, 0);
	}

	#onMessage(message: WireMessage): void {
		if (message.t === "res") {
			const response = WireResponse.safeParse(message);
			if (!response.success) return;
			const pending = this.#pending.get(response.data.id);
			if (!pending) return;
			this.#pending.delete(response.data.id);
			clearTimeout(pending.timer);
			if (response.data.ok) pending.resolve(response.data.result);
			else {
				const { error } = response.data;
				pending.reject(new RemoteError(error.code, error.message, false, tabHolderOf(error) ?? undefined));
			}
			return;
		}
		const event = WireEvent.safeParse(message);
		if (event.success) this.#emitter.emit("event", event.data.event, event.data.data);
	}
}
