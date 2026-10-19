/**
 * The host side (B) of remote devices: a TCP server that pairs new devices
 * with the short-lived code and serves authenticated peers' requests through
 * `HostServices`, plus the LAN beacon while it runs. No Electron imports.
 */
import { EventEmitter } from "node:events";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import { formatAddress, remotePort } from "./address";
import { DEVICE_RENAME_EVENT, HOST_NAME_EVENT, NAME_METHODS, NameParams } from "./app-protocol";
import { authKeys, dh, formatCode, generateCode, generateKeyPair, macEquals, pairKey, pairMac } from "./crypto";
import { BeaconBroadcaster } from "./discovery";
import type { Identity } from "./identity";
import type { PeerInfo, PeerStore } from "./peers-store";
import {
	AuthInit,
	authTranscriptOf,
	ClientHello,
	HANDSHAKE_VERSION,
	HelloVersion,
	Opening,
	type PairChallenge,
	PairInit,
	PairProof,
	PROTOCOL_VERSION,
	pairTranscriptOf,
	WireRequest,
} from "./protocol";
import { Link, type WireMessage } from "./wire";

export const CODE_TTL_MS = 10 * 60_000;
/** Wrong codes allowed before the code rotates; the last one is answered `locked`. */
export const MAX_CODE_FAILURES = 5;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** What the host tells an authenticated client in its hello. */
export interface HostHello {
	protocol: number;
	appVersion: string;
	name: string;
	platform: string;
	ompVersion: string | null;
	home: string;
	sep: string;
}

/** The machine part of the hello, supplied by the integration. */
export type HostMachineInfo = Pick<HostHello, "platform" | "ompVersion" | "home" | "sep">;

export interface HostServices {
	call(peer: PeerInfo, method: string, params: unknown, conn: HostConnection): Promise<unknown>;
	disconnected(peer: PeerInfo, conn: HostConnection): void;
}

export interface HostConnection {
	readonly peer: PeerInfo;
	/** Push `{t:"evt"}`; throws when the event exceeds the frame cap. */
	emit(event: string, data: unknown): void;
	close(): void;
}

export interface PairingCode {
	/** `XXXX-XXXX`. */
	code: string;
	expiresAt: number;
}

export interface RemoteHostOptions {
	identity: Identity;
	peers: PeerStore;
	services: HostServices;
	name: () => string;
	/** TCP port; defaults to `OMP_GUI_REMOTE_PORT` or 47821, falling back to an ephemeral port when busy. */
	port?: number;
	/**
	 * Address to listen on; every interface when omitted. Tests that dial 127.0.0.1 bind it: macOS lets an
	 * IPv4 socket of another process share the port of a `::` listener and take its 127.0.0.1 connections.
	 */
	bindHost?: string;
	/** Beacon UDP port; defaults to `OMP_GUI_REMOTE_DISCOVERY_PORT` or 47822. */
	discoveryPort?: number;
	appVersion: string;
	hello: () => HostMachineInfo;
	/**
	 * A paired device asked to rename this computer (`host.rename`). Applies and announces the name, or
	 * throws a coded error the device shows.
	 */
	renameSelf?: (name: string, by: PeerInfo) => void;
	/** Clock for code expiry (tests). */
	now?: () => number;
}

export type RemoteHostEvent = "peersChanged" | "connectionsChanged" | "codeChanged";

class PeerConnection implements HostConnection {
	readonly link: Link;
	peer: PeerInfo;

	constructor(link: Link, peer: PeerInfo) {
		this.link = link;
		this.peer = peer;
	}

	emit(event: string, data: unknown): void {
		this.link.send({ t: "evt", event, data });
	}

	close(): void {
		this.link.close();
	}
}

/** `{code, message}` for a failed call: a `[code]` marker, else the error's own string code. */
function errorPayload(error: unknown): { code: string; message: string } {
	const message = error instanceof Error ? error.message : String(error);
	const own =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? error.code
			: undefined;
	return { code: ipcErrorCode(error) ?? own ?? "remote_error", message };
}

function listen(server: Server, port: number, host: string | undefined): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	server.once("error", reject);
	server.listen(port, host, () => {
		server.off("error", reject);
		resolve((server.address() as AddressInfo).port);
	});
	return promise;
}

export class RemoteHost {
	readonly #opts: RemoteHostOptions;
	readonly #now: () => number;
	readonly #emitter = new EventEmitter();
	readonly #links = new Set<Link>();
	readonly #connections = new Set<PeerConnection>();
	#server: Server | null = null;
	#starting: Promise<{ port: number }> | null = null;
	#beacon: BeaconBroadcaster | null = null;
	#port: number | null = null;
	#code: { code: string; expiresAt: number };
	#failures = 0;

	constructor(opts: RemoteHostOptions) {
		this.#opts = opts;
		this.#now = opts.now ?? Date.now;
		this.#code = { code: generateCode(), expiresAt: this.#now() + CODE_TTL_MS };
	}

	/** The listening TCP port, or null while stopped. */
	get port(): number | null {
		return this.#port;
	}

	/** Listen and beacon; concurrent and repeated calls share one start. */
	start(): Promise<{ port: number }> {
		this.#starting ??= this.#start().catch(error => {
			this.#starting = null;
			throw error;
		});
		return this.#starting;
	}

	async #start(): Promise<{ port: number }> {
		const wanted = this.#opts.port ?? remotePort();
		let server = this.#createServer();
		let port: number;
		try {
			port = await listen(server, wanted, this.#opts.bindHost);
		} catch (error) {
			if (wanted === 0 || !(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
			server = this.#createServer();
			port = await listen(server, 0, this.#opts.bindHost);
		}
		this.#server = server;
		this.#port = port;
		const beacon = new BeaconBroadcaster({
			port: this.#opts.discoveryPort,
			beacon: () => ({ deviceId: this.#opts.identity.deviceId, name: this.#opts.name(), port }),
		});
		this.#beacon = beacon;
		await beacon.start();
		return { port };
	}

	async stop(): Promise<void> {
		await this.#starting?.catch(() => undefined);
		this.#starting = null;
		const server = this.#server;
		this.#server = null;
		this.#port = null;
		this.#beacon?.stop();
		this.#beacon = null;
		for (const link of [...this.#links]) link.destroy();
		if (!server) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await promise;
	}

	/** The current code; an expired one is replaced first. */
	pairingCode(): PairingCode {
		if (this.#now() >= this.#code.expiresAt) return this.rotateCode();
		return { code: formatCode(this.#code.code), expiresAt: this.#code.expiresAt };
	}

	rotateCode(): PairingCode {
		this.#code = { code: generateCode(), expiresAt: this.#now() + CODE_TTL_MS };
		this.#failures = 0;
		this.#emitter.emit("codeChanged");
		return { code: formatCode(this.#code.code), expiresAt: this.#code.expiresAt };
	}

	/** `ip:port` for each non-internal IPv4 interface while listening. */
	addresses(): string[] {
		const port = this.#port;
		if (port === null) return [];
		const out: string[] = [];
		for (const infos of Object.values(networkInterfaces())) {
			for (const info of infos ?? []) {
				if (info.family === "IPv4" && !info.internal) out.push(formatAddress({ host: info.address, port }));
			}
		}
		return out;
	}

	/** Peers with at least one live authenticated connection. */
	connections(): PeerInfo[] {
		const peers = new Map<string, PeerInfo>();
		for (const conn of this.#connections) peers.set(conn.peer.deviceId, { ...conn.peer });
		return [...peers.values()];
	}

	/** Unpair a device and drop its live connections. */
	async revoke(deviceId: string): Promise<void> {
		const removed = this.#opts.peers.remove(deviceId);
		for (const conn of [...this.#connections]) if (conn.peer.deviceId === deviceId) conn.link.destroy();
		if (removed) this.#emitter.emit("peersChanged");
	}

	on(event: RemoteHostEvent, fn: () => void): void {
		this.#emitter.on(event, fn);
	}

	off(event: RemoteHostEvent, fn: () => void): void {
		this.#emitter.off(event, fn);
	}

	#createServer(): Server {
		return createServer(socket => this.#accept(socket));
	}

	#accept(socket: Socket): void {
		const link = new Link(socket);
		this.#links.add(link);
		link.onClose(() => this.#links.delete(link));
		this.#handshake(link).catch(() => link.destroy());
	}

	async #handshake(link: Link): Promise<void> {
		const first = await link.receive(HANDSHAKE_TIMEOUT_MS);
		const opening = Opening.safeParse(first);
		if (!opening.success) {
			link.destroy();
			return;
		}
		if (opening.data.v !== HANDSHAKE_VERSION) {
			link.send({ t: "error", code: "protocol" });
			link.close();
			return;
		}
		if (opening.data.t === "pair-init") await this.#pair(link, PairInit.parse(first));
		else await this.#auth(link, AuthInit.parse(first));
	}

	/** Pairing, host side: the client proves the code first; B answers only a correct proof. */
	async #pair(link: Link, init: PairInit): Promise<void> {
		const { identity, peers } = this.#opts;
		const eph = generateKeyPair();
		const challenge: PairChallenge = {
			t: "pair-challenge",
			deviceId: identity.deviceId,
			name: this.#opts.name(),
			ephPub: eph.publicKey,
			staticPub: identity.publicKey,
		};
		link.send(challenge);
		const proof = PairProof.parse(await link.receive(HANDSHAKE_TIMEOUT_MS));
		const now = this.#now();
		const fail = (code: "wrong_code" | "expired" | "locked") => {
			link.send({ t: "pair-fail", code });
			link.close();
		};
		if (now >= this.#code.expiresAt) return fail("expired");
		const key = pairKey(dh(eph.privateKey, init.ephPub), this.#code.code, pairTranscriptOf(init, challenge));
		if (!macEquals(pairMac(key, "A"), proof.mac)) {
			this.#failures++;
			if (this.#failures < MAX_CODE_FAILURES) return fail("wrong_code");
			this.rotateCode();
			return fail("locked");
		}
		// Single use: the next device needs the next code.
		this.rotateCode();
		peers.put({ deviceId: init.deviceId, name: init.name, staticPub: init.staticPub, pairedAt: now });
		this.#emitter.emit("peersChanged");
		link.send({ t: "pair-ok", mac: pairMac(key, "B") });
		link.close();
	}

	/** Auth, host side: KK-like key agreement over both static and ephemeral keys, then hellos. */
	async #auth(link: Link, init: AuthInit): Promise<void> {
		const { identity, peers } = this.#opts;
		const peer = peers.get(init.deviceId);
		if (!peer) {
			link.send({ t: "auth-fail", code: "unpaired" });
			link.close();
			return;
		}
		const eph = generateKeyPair();
		link.send({ t: "auth-resp", deviceId: identity.deviceId, ephPub: eph.publicKey });
		// DH(eA,eB) || DH(sA,eB) || DH(eA,sB), computed from B's side.
		const ikm = Buffer.concat([
			dh(eph.privateKey, init.ephPub),
			dh(eph.privateKey, peer.staticPub),
			dh(identity.privateKey, init.ephPub),
		]);
		const keys = authKeys(
			ikm,
			authTranscriptOf(
				{ deviceId: init.deviceId, ephPub: init.ephPub, staticPub: peer.staticPub },
				{ deviceId: identity.deviceId, ephPub: eph.publicKey, staticPub: identity.publicKey },
			),
		);
		link.secure(keys.ba, keys.ab);
		const first = await link.receive(HANDSHAKE_TIMEOUT_MS);
		const version = HelloVersion.parse(first);
		if (version.protocol !== PROTOCOL_VERSION) {
			link.send({ t: "error", code: "protocol" });
			link.close();
			return;
		}
		const hello = ClientHello.parse(first);
		// Revoked while the handshake ran.
		if (!peers.get(peer.deviceId)) {
			link.destroy();
			return;
		}
		link.send({
			t: "hello",
			protocol: PROTOCOL_VERSION,
			appVersion: this.#opts.appVersion,
			name: this.#opts.name(),
			...this.#opts.hello(),
		});
		const current = peers.update(peer.deviceId, { name: hello.name, lastSeenAt: this.#now() }) ?? peer;
		const conn = new PeerConnection(link, current);
		this.#connections.add(conn);
		link.onClose(() => this.#disconnected(conn));
		link.listen(message => this.#onMessage(conn, message));
		this.#emitter.emit("peersChanged");
		this.#emitter.emit("connectionsChanged");
	}

	#disconnected(conn: PeerConnection): void {
		this.#connections.delete(conn);
		const seen = this.#opts.peers.update(conn.peer.deviceId, { lastSeenAt: this.#now() });
		if (seen) conn.peer = seen;
		this.#opts.services.disconnected(conn.peer, conn);
		if (seen) this.#emitter.emit("peersChanged");
		this.#emitter.emit("connectionsChanged");
	}

	#onMessage(conn: PeerConnection, message: WireMessage): void {
		// Unknown message types are ignored so a newer client can add some.
		const request = WireRequest.safeParse(message);
		if (!request.success) return;
		const { id, method, params } = request.data;
		if (method === NAME_METHODS.peerName || method === NAME_METHODS.hostRename) {
			this.#serveName(conn, id, method, params);
			return;
		}
		void this.#serve(conn, id, method, params);
	}

	/** The device names itself (`peer.name`), or renames this computer (`host.rename`). */
	#serveName(conn: PeerConnection, id: number, method: string, params: unknown): void {
		let reply: object;
		try {
			const parsed = NameParams.safeParse(params);
			if (!parsed.success) throw codedError("invalid_name", "Invalid device name");
			const { name } = parsed.data;
			if (method === NAME_METHODS.peerName) {
				const updated = this.#opts.peers.update(conn.peer.deviceId, { name });
				if (updated) conn.peer = updated;
				this.#emitter.emit("peersChanged");
			} else {
				if (!this.#opts.renameSelf) throw codedError("invalid_name", "Renaming is not supported");
				this.#opts.renameSelf(name, conn.peer);
			}
			reply = { t: "res", id, ok: true, result: null };
		} catch (error) {
			reply = { t: "res", id, ok: false, error: errorPayload(error) };
		}
		conn.link.send(reply);
	}

	/** Tell every connected device this computer's current name (`host.name`). */
	announceName(): void {
		const name = this.#opts.name();
		for (const conn of this.#connections) conn.emit(HOST_NAME_EVENT, { name });
	}

	/** Ask a connected device to rename itself (`device.rename`); false while it is not connected. */
	askPeerRename(deviceId: string, name: string): boolean {
		const conns = [...this.#connections].filter(conn => conn.peer.deviceId === deviceId);
		for (const conn of conns) conn.emit(DEVICE_RENAME_EVENT, { name });
		return conns.length > 0;
	}

	async #serve(conn: PeerConnection, id: number, method: string, params: unknown): Promise<void> {
		let reply: object;
		try {
			const result = await this.#opts.services.call(conn.peer, method, params, conn);
			reply = { t: "res", id, ok: true, result };
		} catch (error) {
			reply = { t: "res", id, ok: false, error: errorPayload(error) };
		}
		try {
			conn.link.send(reply);
		} catch (error) {
			conn.link.send({
				t: "res",
				id,
				ok: false,
				error: { code: "too_large", message: errorPayload(error).message },
			});
		}
	}
}
