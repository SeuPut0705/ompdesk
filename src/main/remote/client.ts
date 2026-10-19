/**
 * The client side (A) of remote devices. `probeHost` asks an address whether an OMPdesk host answers there and
 * lets this device in (it shows the host before any connection); `connectFirst` runs the handshake once with a
 * host this device never connected to and pins the host's key; a `RemoteClient` per known host keeps one
 * authenticated link up (reconnecting with 1 s → 30 s backoff over the host's current addresses) and carries
 * requests and pushed events.
 */
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { formatAddress, type HostPort, parseAddress } from "./address";
import { authKeys, dh, generateKeyPair } from "./crypto";
import type { HostHello } from "./host-server";
import type { HostStore, PairedHost } from "./hosts-store";
import type { Identity } from "./identity";
import {
	AuthReply,
	authTranscriptOf,
	HANDSHAKE_VERSION,
	HelloVersion,
	HostHelloMessage,
	PROTOCOL_VERSION,
	ProbeReply,
	WireEvent,
	WireResponse,
} from "./protocol";
import { Link, type WireMessage } from "./wire";

export type LinkState = "connecting" | "online" | "offline";

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 3_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * A remote failure with a stable code: the host's refusal (`REFUSAL_CODES` in protocol.ts), this side's
 * (`key_mismatch` for a host that answers with another key, `unreachable`, `protocol`), links (`remote_offline`,
 * `timeout`, `too_large`), or whatever code the host's handler failed with.
 */
export class RemoteError extends Error {
	readonly code: string;

	constructor(code: string, message: string = code) {
		super(message);
		this.name = "RemoteError";
		this.code = code;
	}
}

function dial(target: HostPort, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Socket> {
	const socket = connect({ host: target.host, port: target.port });
	const { promise, resolve, reject } = Promise.withResolvers<Socket>();
	const fail = (error: Error) => {
		socket.destroy();
		reject(new RemoteError("unreachable", `${formatAddress(target)}: ${error.message}`));
	};
	socket.setTimeout(timeoutMs, () => fail(new Error("connect timed out")));
	socket.once("error", fail);
	socket.once("connect", () => {
		socket.setTimeout(0);
		socket.off("error", fail);
		resolve(socket);
	});
	return promise;
}

/** RemoteErrors pass through; anything else (closed, timed out) means the host is out of reach. */
function asRemoteError(error: unknown): RemoteError {
	if (error instanceof RemoteError) return error;
	return new RemoteError("unreachable", error instanceof Error ? error.message : String(error));
}

async function dialAddress(address: string, timeoutMs?: number): Promise<Link> {
	const target = parseAddress(address);
	if (!target) throw new RemoteError("unreachable", `invalid address: ${address}`);
	return new Link(await dial(target, timeoutMs));
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
	const link = await dialAddress(address, PROBE_TIMEOUT_MS);
	try {
		link.send({ t: "probe", v: HANDSHAKE_VERSION });
		const reply = ProbeReply.safeParse(await link.receive(PROBE_TIMEOUT_MS));
		if (!reply.success) throw new RemoteError("unreachable", `${address} is not an OMPdesk host`);
		if (reply.data.t === "error") return { ok: false, code: reply.data.code };
		return { ok: true, deviceId: reply.data.deviceId, name: reply.data.name, appVersion: reply.data.appVersion };
	} catch (error) {
		throw asRemoteError(error);
	} finally {
		link.close();
	}
}

interface HandshakeOptions {
	identity: Identity;
	name: string;
	appVersion: string;
	/** The host this device pinned: its id and key must answer. Null on first contact (the key is pinned then). */
	expected: { deviceId: string; staticPub: string } | null;
}

interface Handshake {
	link: Link;
	hello: HostHello;
	host: { deviceId: string; name: string; staticPub: string };
}

/**
 * Auth, client side: both static keys and both ephemeral keys go into the session keys (DH(eA,eB) ‖ DH(sA,eB) ‖
 * DH(eA,sB)), so only the holder of the host key this device pinned can read or answer the link.
 */
async function handshake(address: string, opts: HandshakeOptions): Promise<Handshake> {
	const link = await dialAddress(address);
	try {
		const { identity } = opts;
		const eph = generateKeyPair();
		link.send({
			t: "auth-init",
			v: HANDSHAKE_VERSION,
			deviceId: identity.deviceId,
			name: opts.name,
			ephPub: eph.publicKey,
			staticPub: identity.publicKey,
		});
		const reply = AuthReply.safeParse(await link.receive(HANDSHAKE_TIMEOUT_MS));
		if (!reply.success) throw new RemoteError("protocol", "malformed auth reply");
		if (reply.data.t !== "auth-resp") throw new RemoteError(reply.data.code);
		const answer = reply.data;
		if (opts.expected) {
			// Another device now answers at this address.
			if (answer.deviceId !== opts.expected.deviceId) {
				throw new RemoteError("unreachable", `${address} is another device`);
			}
			if (answer.staticPub !== opts.expected.staticPub) {
				throw new RemoteError("key_mismatch", `${address} answers with another key than the one pinned`);
			}
		}
		const ikm = Buffer.concat([
			dh(eph.privateKey, answer.ephPub),
			dh(identity.privateKey, answer.ephPub),
			dh(eph.privateKey, answer.staticPub),
		]);
		const keys = authKeys(
			ikm,
			authTranscriptOf(
				{ deviceId: identity.deviceId, ephPub: eph.publicKey, staticPub: identity.publicKey },
				{ deviceId: answer.deviceId, ephPub: answer.ephPub, staticPub: answer.staticPub },
			),
		);
		link.secure(keys.ab, keys.ba);
		link.send({ t: "hello", protocol: PROTOCOL_VERSION, appVersion: opts.appVersion, name: opts.name });
		const message = await link.receive(HANDSHAKE_TIMEOUT_MS);
		if (message.t === "error") throw new RemoteError(String(message.code ?? "protocol"));
		const version = HelloVersion.safeParse(message);
		if (!version.success || version.data.protocol !== PROTOCOL_VERSION) {
			throw new RemoteError("protocol", `host protocol ${String(message.protocol)}, ours ${PROTOCOL_VERSION}`);
		}
		const hello = HostHelloMessage.safeParse(message);
		if (!hello.success) throw new RemoteError("protocol", "malformed host hello");
		const { t: _t, ...info } = hello.data;
		return { link, hello: info, host: { deviceId: answer.deviceId, name: info.name, staticPub: answer.staticPub } };
	} catch (error) {
		link.destroy();
		throw asRemoteError(error);
	}
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
	const { link, host } = await handshake(opts.address, {
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
	#retryTimer: NodeJS.Timeout | undefined;
	#backoff = RECONNECT_MIN_MS;
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
		clearTimeout(this.#retryTimer);
		void this.#attempt();
	}

	/** Stop reconnecting and drop the link; pending requests reject `remote_offline`. */
	close(): void {
		this.#running = false;
		clearTimeout(this.#retryTimer);
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

	async #attempt(): Promise<void> {
		this.#attempting = true;
		this.#setState("connecting");
		const addresses = await this.#addresses();
		let failure = new RemoteError("unreachable", "no address to dial");
		for (const address of addresses) {
			if (!this.#running) break;
			try {
				const { link, hello } = await handshake(address, {
					identity: this.#opts.identity,
					name: this.#opts.name(),
					appVersion: this.#opts.appVersion,
					expected: { deviceId: this.deviceId, staticPub: this.#host.staticPub },
				});
				if (!this.#running) {
					link.destroy();
					break;
				}
				this.#attempting = false;
				this.#online(link, hello, address);
				return;
			} catch (error) {
				failure = asRemoteError(error);
				// The host itself answered: other addresses reach the same verdict.
				if (failure.code !== "unreachable") break;
			}
		}
		this.#attempting = false;
		if (!this.#running) return;
		this.#error = failure.code;
		this.#setState("offline");
		this.#scheduleRetry();
	}

	#online(link: Link, hello: HostHello, address: string): void {
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
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			pending.reject(new RemoteError("remote_offline", `${this.#host.name} went offline`));
		}
		this.#setState("offline");
		this.#scheduleRetry();
	}

	#scheduleRetry(): void {
		if (!this.#running) return;
		const delay = this.#backoff;
		this.#backoff = Math.min(this.#backoff * 2, RECONNECT_MAX_MS);
		clearTimeout(this.#retryTimer);
		this.#retryTimer = setTimeout(() => void this.#attempt(), delay);
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
			else pending.reject(new RemoteError(response.data.error.code, response.data.error.message));
			return;
		}
		const event = WireEvent.safeParse(message);
		if (event.success) this.#emitter.emit("event", event.data.event, event.data.data);
	}
}
