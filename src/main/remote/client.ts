/**
 * The client side (A) of remote devices, as main holds it. `probeHost` asks an address whether an OMPdesk host
 * answers there and lets this device in; `connectFirst` runs the handshake once with a host this device never
 * connected to and pins its key. A `RemoteClient` per known host mirrors the core's reconnecting client
 * (`crates/core/src/remote/devices/client.rs`: the dial, the handshake, the 1 s → 30 s backoff, wake and the
 * refused-retry window) and carries requests and pushed events on the link the core brings up: every request and
 * event on a link is main's.
 */
import { EventEmitter } from "node:events";
import { CORE_EXITED, core } from "../core/process";
import { openAgain } from "../core/reopen";
import type { HostHello } from "./host-server";
import type { PairedHost } from "./hosts-store";
import type { Identity } from "./identity";
import { type TabHolder, tabHolderOf, WireEvent, WireResponse } from "./protocol";
import type { SharingCore } from "./sharing";
import { Link, type Liveness, type WireMessage } from "./wire";

export type LinkState = "connecting" | "online" | "offline";

/**
 * What may say the network or the computer changed: the client checks (online) or retries (offline) at once.
 * `peer`: the host's computer just connected to this one, so it is up now, even while a dial to it still hangs.
 */
export type WakeTrigger = "resume" | "unlock" | "online" | "tailnet" | "focus" | "peer";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
export const HELLO_CAPABILITIES = {
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

export interface FirstContactOptions {
	identity: Identity;
	address: string;
	name: string;
	appVersion: string;
	/** The host's Tailscale node, recorded with it. */
	nodeId: string;
	/** Where `remote-hosts.json` is. */
	userData: string;
}

/**
 * Connect once to a host this device never connected to, pin its key and node, and record it. A host already
 * pinned to that node must answer with the same id and key (`key_mismatch` otherwise).
 */
export async function connectFirst(opts: FirstContactOptions): Promise<PairedHost> {
	const { result } = await core()
		.call<Failed | { host: PairedHost }>(
			"remote.connectFirst",
			{
				identity: opts.identity.deviceId,
				userData: opts.userData,
				address: opts.address,
				name: opts.name,
				appVersion: opts.appVersion,
				nodeId: opts.nodeId,
				capabilities: HELLO_CAPABILITIES,
			},
			{ timeoutMs: 60_000 },
		)
		.catch(error => {
			throw asRemoteError(error);
		});
	if ("failed" in result) throw failure(result);
	return result.host;
}

export interface RemoteClientOptions {
	identity: Identity;
	host: PairedHost;
	appVersion: string;
	/** This device's name for the hello; a devices instance tells its clients later names itself. */
	name: () => string;
	/** The devices instance whose tailnet finds the host and wakes the link; without, the record's stored addresses. */
	sharing?: SharingCore;
	/** Where `remote-hosts.json` is: the pinned record is read from it on every attempt and told the working address. */
	userData?: string;
	/** The link's transitions for the runtime log (`remote-link`): `down`, each `attempt`, `up`. No addresses or keys. */
	log?: (event: "down" | "attempt" | "up", details: Record<string, unknown>) => void;
	/** The link's ping and dead timers (tests shorten them). */
	liveness?: Liveness;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: RemoteError) => void;
	timer: NodeJS.Timeout;
}

/** What the core tells of a client (`remote.client.state`). */
interface ClientTold {
	client: number;
	state: LinkState;
	error: string | null;
	hello: HostHello | null;
	host: PairedHost;
	link: number | null;
}

const clients = new Map<number, RemoteClient>();
let routed = false;

function route(): void {
	if (routed) return;
	routed = true;
	const process = core();
	process.on("remote.client.state", data => clients.get((data as ClientTold).client)?.told(data as ClientTold));
	process.on("remote.client.log", data => {
		const { client, event, details } = data as {
			client: number;
			event: "down" | "attempt" | "up";
			details: Record<string, unknown>;
		};
		clients.get(client)?.logged(event, details);
	});
	// A core that ends takes every client's loop with it: each opens again in the next one, under a new number.
	process.on(CORE_EXITED, () => {
		const lost = [...clients.values()];
		clients.clear();
		for (const client of lost) client.lost();
	});
}

/** One known host's link: the core keeps it up; this side carries its requests and events. */
export class RemoteClient {
	readonly deviceId: string;
	readonly #opts: RemoteClientOptions;
	readonly #emitter = new EventEmitter();
	readonly #pending = new Map<number, Pending>();
	#id: Promise<number>;
	/** Bumped each time the loop is opened again, so an attempt a later one superseded gives up. */
	#opens = 0;
	#host: PairedHost;
	#state: LinkState = "offline";
	#hello: HostHello | null = null;
	#error: string | null = null;
	#link: Link | null = null;
	#closed = false;
	/** `connect` was called: the core is reconnecting this link. */
	#running = false;
	#nextId = 1;

	constructor(opts: RemoteClientOptions) {
		this.#opts = opts;
		this.#host = { ...opts.host, addresses: [...opts.host.addresses] };
		this.deviceId = opts.host.deviceId;
		route();
		this.#id = this.#begin();
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

	#push(method: string, params: object = {}): void {
		void this.#id.then(
			client => core().push(method, { client, ...params }),
			() => undefined,
		);
	}

	/** The host announced a new name (`host.name`): show and remember it. */
	hostRenamed(name: string): void {
		this.#host.name = name;
		if (this.#hello) this.#hello = { ...this.#hello, name };
		this.#push("remote.client.hostRenamed", { name });
	}

	/** Start (or keep) the link; while waiting out a backoff, retry now. */
	connect(): void {
		this.#running = true;
		this.#push("remote.client.connect");
		this.#attemptingNow();
	}

	/**
	 * The network or the computer may have changed under the link: offline or waiting out a backoff, the core starts
	 * over from a 1 s backoff and tries now; online, it pings and drops the link if nothing answers within
	 * `WAKE_CHECK_MS`; on `peer` it ends a dial stuck on the host's restart (`client.rs`).
	 */
	wake(trigger: WakeTrigger): void {
		this.#push("remote.client.wake", { trigger });
		this.#attemptingNow();
	}

	/**
	 * An offline link the core is reconnecting tries now on `connect` and `wake` (`retry_now`): told here at once, as
	 * the loop told it when it ran in main, so a caller that waits for the next `offline` waits for this attempt's.
	 */
	#attemptingNow(): void {
		if (this.#running && !this.#closed && this.#state === "offline") this.#setState("connecting");
	}

	/** Stop reconnecting and drop the link; pending requests reject `remote_offline`. */
	close(): void {
		this.#push("remote.client.close");
		this.#closed = true;
		this.#setState("offline");
		this.#dropLink(`${this.#host.name} went offline`);
		void this.#id.then(
			client => {
				if (clients.get(client) === this) clients.delete(client);
			},
			() => undefined,
		);
	}

	/**
	 * The core ended and took this client's loop with it (the numbers it held start over in the next core): offline now,
	 * and the loop is opened again there, started again when it ran.
	 */
	lost(): void {
		if (this.#closed) return;
		this.#dropLink(`${this.#host.name} went offline`);
		this.#setState("offline");
		this.#id = this.#begin();
	}

	/** Opens the loop in the core that runs, or the next one, until it is; the latest call is the one that counts. */
	#begin(): Promise<number> {
		const opened = this.#openAgain(++this.#opens);
		opened.catch(() => undefined);
		return opened;
	}

	async #openAgain(token: number): Promise<number> {
		// The devices instance this client belongs to opens again in its own listener of the same exit; by the next turn
		// `opened()` waits for that one.
		await Promise.resolve();
		const wanted = () => !this.#closed && token === this.#opens;
		const opened = await openAgain(() => this.#openInCore(), wanted);
		if (!opened) throw new RemoteError("remote_offline", `${this.#host.name} went offline`);
		if (!wanted()) {
			if (core().generation === opened.generation) core().push("remote.client.close", { client: opened.client });
			throw new RemoteError("remote_offline", `${this.#host.name} went offline`);
		}
		clients.set(opened.client, this);
		if (this.#running) {
			core().push("remote.client.connect", { client: opened.client });
			this.#attemptingNow();
		}
		return opened.client;
	}

	async #openInCore(): Promise<{ client: number; generation: number }> {
		const opts = this.#opts;
		const devices = await opts.sharing?.opened();
		const { result, generation } = await core().call<{ client: number }>("remote.client.open", {
			identity: opts.identity.deviceId,
			host: this.#host,
			appVersion: opts.appVersion,
			name: opts.name(),
			capabilities: HELLO_CAPABILITIES,
			...(devices !== undefined ? { devices } : {}),
			...(opts.userData ? { userData: opts.userData } : {}),
			...(opts.liveness ? { liveness: opts.liveness } : {}),
		});
		return { client: result.client, generation };
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

	/** A transition the core told. */
	told(told: ClientTold): void {
		if (this.#closed) return;
		this.#host = { ...told.host, addresses: [...told.host.addresses] };
		this.#hello = told.hello;
		this.#error = told.error;
		if (told.state === "online" && told.link !== null && this.#link?.id !== told.link) {
			const link = new Link(told.link);
			this.#link = link;
			link.onClose(() => {
				if (this.#link === link) this.#dropLink(`${this.#host.name} went offline`);
			});
			link.listen(message => this.#onMessage(message));
		}
		if (told.state !== "online") this.#dropLink(`${this.#host.name} went offline`);
		this.#setState(told.state);
	}

	/** A transition the core logged for this link. */
	logged(event: "down" | "attempt" | "up", details: Record<string, unknown>): void {
		this.#opts.log?.(event, details);
	}

	#dropLink(message: string): void {
		this.#link = null;
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			pending.reject(new RemoteError("remote_offline", message));
		}
	}

	#setState(state: LinkState): void {
		if (this.#state === state) return;
		this.#state = state;
		this.#emitter.emit("state", state);
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
