/**
 * The client side (A) of remote devices: `pairWithHost` runs the pairing
 * handshake once, and a `RemoteClient` per paired host keeps one
 * authenticated link up (reconnecting with 1 s → 30 s backoff over the
 * host's stored addresses) and carries requests and pushed events.
 */
import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { formatAddress, type HostPort, parseAddress } from "./address";
import { authKeys, dh, generateKeyPair, macEquals, normalizeCode, pairKey, pairMac } from "./crypto";
import type { HostHello } from "./host-server";
import type { HostStore, PairedHost } from "./hosts-store";
import type { Identity } from "./identity";
import {
	AuthReply,
	authTranscriptOf,
	HANDSHAKE_VERSION,
	HelloVersion,
	HostHelloMessage,
	PairChallenge,
	type PairInit,
	PairResult,
	PROTOCOL_VERSION,
	pairTranscriptOf,
	WireEvent,
	WireResponse,
} from "./protocol";
import { Link, type WireMessage } from "./wire";

export type LinkState = "connecting" | "online" | "offline";

export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * A remote failure with a stable code: pairing (`wrong_code`, `expired`,
 * `locked`, `unreachable`, `protocol`), links (`remote_offline`, `unpaired`,
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

function dial(target: HostPort): Promise<Socket> {
	const socket = connect({ host: target.host, port: target.port });
	const { promise, resolve, reject } = Promise.withResolvers<Socket>();
	const fail = (error: Error) => {
		socket.destroy();
		reject(new RemoteError("unreachable", `${formatAddress(target)}: ${error.message}`));
	};
	socket.setTimeout(CONNECT_TIMEOUT_MS, () => fail(new Error("connect timed out")));
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

export interface PairOptions {
	identity: Identity;
	/** `host`, `host:port`, `[v6]:port`. */
	address: string;
	code: string;
	name: string;
	appVersion: string;
	/** Persist the host here on success (keeping its older addresses). */
	hosts?: HostStore;
}

/**
 * Pair with the host at `address` using its displayed code. Throws RemoteError
 * `wrong_code`, `expired`, `locked`, `unreachable` or `protocol`.
 */
export async function pairWithHost(opts: PairOptions): Promise<PairedHost> {
	const code = normalizeCode(opts.code);
	if (!code) throw new RemoteError("wrong_code", "the code must be 8 characters");
	const target = parseAddress(opts.address);
	if (!target) throw new RemoteError("unreachable", `invalid address: ${opts.address}`);
	const link = new Link(await dial(target));
	try {
		const eph = generateKeyPair();
		const init: PairInit = {
			t: "pair-init",
			v: HANDSHAKE_VERSION,
			deviceId: opts.identity.deviceId,
			name: opts.name,
			ephPub: eph.publicKey,
			staticPub: opts.identity.publicKey,
		};
		link.send(init);
		const reply = await link.receive(HANDSHAKE_TIMEOUT_MS);
		if (reply.t === "error") throw new RemoteError(String(reply.code ?? "protocol"));
		const challenge = PairChallenge.safeParse(reply);
		if (!challenge.success) throw new RemoteError("protocol", "malformed pairing challenge");
		const key = pairKey(dh(eph.privateKey, challenge.data.ephPub), code, pairTranscriptOf(init, challenge.data));
		link.send({ t: "pair-proof", mac: pairMac(key, "A") });
		const result = PairResult.safeParse(await link.receive(HANDSHAKE_TIMEOUT_MS));
		if (!result.success) throw new RemoteError("protocol", "malformed pairing result");
		if (result.data.t !== "pair-ok") throw new RemoteError(result.data.code);
		if (!macEquals(pairMac(key, "B"), result.data.mac)) {
			throw new RemoteError("protocol", "the host could not prove it knows the code");
		}
		const address = formatAddress(target);
		const previous = opts.hosts?.get(challenge.data.deviceId);
		const host: PairedHost = {
			deviceId: challenge.data.deviceId,
			name: challenge.data.name,
			staticPub: challenge.data.staticPub,
			addresses: [address, ...(previous?.addresses.filter(a => a !== address) ?? [])],
			pairedAt: Date.now(),
		};
		opts.hosts?.put(host);
		return opts.hosts?.get(host.deviceId) ?? host;
	} catch (error) {
		throw asRemoteError(error);
	} finally {
		link.close();
	}
}

export interface RemoteClientOptions {
	identity: Identity;
	host: PairedHost;
	appVersion: string;
	name: () => string;
	/** Read addresses from here on every attempt, and record the working one and the host's name. */
	hosts?: HostStore;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: RemoteError) => void;
	timer: NodeJS.Timeout;
}

/** One paired host's link; auto-reconnects with backoff 1 s → 30 s between rounds of its addresses. */
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

	/** Why the last attempt failed (`unreachable`, `unpaired`, `protocol`); null once online. */
	get error(): string | null {
		return this.#error;
	}

	get host(): PairedHost {
		return { ...this.#host, addresses: [...this.#host.addresses] };
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

	async #attempt(): Promise<void> {
		this.#attempting = true;
		this.#setState("connecting");
		const addresses = this.#opts.hosts?.get(this.deviceId)?.addresses ?? this.#host.addresses;
		let failure = new RemoteError("unreachable", "no address to dial");
		for (const address of addresses) {
			if (!this.#running) break;
			try {
				const { link, hello } = await this.#open(address);
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

	/** Auth, client side: KK-like key agreement, then the hello exchange. */
	async #open(address: string): Promise<{ link: Link; hello: HostHello }> {
		const target = parseAddress(address);
		if (!target) throw new RemoteError("unreachable", `invalid address: ${address}`);
		const link = new Link(await dial(target));
		try {
			const { identity } = this.#opts;
			const eph = generateKeyPair();
			link.send({ t: "auth-init", v: HANDSHAKE_VERSION, deviceId: identity.deviceId, ephPub: eph.publicKey });
			const reply = AuthReply.safeParse(await link.receive(HANDSHAKE_TIMEOUT_MS));
			if (!reply.success) throw new RemoteError("protocol", "malformed auth reply");
			if (reply.data.t !== "auth-resp") throw new RemoteError(reply.data.code);
			// Another device now answers at this address.
			if (reply.data.deviceId !== this.deviceId)
				throw new RemoteError("unreachable", `${address} is another device`);
			const ikm = Buffer.concat([
				dh(eph.privateKey, reply.data.ephPub),
				dh(identity.privateKey, reply.data.ephPub),
				dh(eph.privateKey, this.#host.staticPub),
			]);
			const keys = authKeys(
				ikm,
				authTranscriptOf(
					{ deviceId: identity.deviceId, ephPub: eph.publicKey, staticPub: identity.publicKey },
					{ deviceId: this.deviceId, ephPub: reply.data.ephPub, staticPub: this.#host.staticPub },
				),
			);
			link.secure(keys.ab, keys.ba);
			link.send({
				t: "hello",
				protocol: PROTOCOL_VERSION,
				appVersion: this.#opts.appVersion,
				name: this.#opts.name(),
			});
			const answer = await link.receive(HANDSHAKE_TIMEOUT_MS);
			if (answer.t === "error") throw new RemoteError(String(answer.code ?? "protocol"));
			const version = HelloVersion.safeParse(answer);
			if (!version.success || version.data.protocol !== PROTOCOL_VERSION) {
				throw new RemoteError("protocol", `host protocol ${String(answer.protocol)}, ours ${PROTOCOL_VERSION}`);
			}
			const hello = HostHelloMessage.safeParse(answer);
			if (!hello.success) throw new RemoteError("protocol", "malformed host hello");
			const { t: _t, ...info } = hello.data;
			return { link, hello: info };
		} catch (error) {
			link.destroy();
			throw error;
		}
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
