/**
 * The host side (B) of remote devices: a TCP server on this computer's tailnet addresses only, that lets in the
 * devices Tailscale vouches for and serves their requests through `HostServices`. No Electron imports.
 *
 * Who may connect is decided per connection by `gate` (the integration asks `tailscale whois` about the peer's
 * address: an allowed login, a node that is not blocked). The first authenticated connection of a device pins its
 * static key to its Tailscale node; later ones must come from that node with that key. A node holds one device.
 */
import { EventEmitter } from "node:events";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import { formatAddress, remotePortCandidates } from "./address";
import { DEVICE_RENAME_EVENT, HOST_NAME_EVENT, NAME_METHODS, NameParams } from "./app-protocol";
import { authKeys, dh, generateKeyPair } from "./crypto";
import type { Identity } from "./identity";
import { logLinkTraffic } from "./link-traffic";
import type { PeerInfo, PeerStore } from "./peers-store";
import {
	AuthInit,
	authTranscriptOf,
	ClientHello,
	HANDSHAKE_VERSION,
	HelloVersion,
	Opening,
	PROTOCOL_VERSION,
	type RefusalCode,
	WireRequest,
} from "./protocol";
import { Link, type WireMessage } from "./wire";

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
	/** The device's hello asked for slim `events` and `subagentFrame` (`link-events.ts`); absent for an older device. */
	readonly slimEvents?: boolean;
	/** It also rebuilds progress snapshots from deltas and takes subagent frames in arrays (`slimProgress`, protocol.ts). */
	readonly slimProgress?: boolean;
	/** It also rebuilds an Autopilot status from a delta against the last one (`slimAutopilot`, protocol.ts). */
	readonly slimAutopilot?: boolean;
	/** Push `{t:"evt"}`; throws when the event exceeds the frame cap. */
	emit(event: string, data: unknown): void;
	close(): void;
}

/** Who Tailscale says connects (the gate let it through). */
export interface TailnetVisitor {
	nodeId: string;
	login: string;
	/** The node's name, for the approval question. */
	nodeName: string | null;
	ip: string;
}

export type GateResult = { ok: true; visitor: TailnetVisitor } | { ok: false; code: RefusalCode };

/** Why the host listens nowhere (`port_in_use`: every candidate port is taken on a tailnet address). */
export interface ListenError {
	code: "port_in_use";
	ports: number[];
}

export interface RemoteHostOptions {
	identity: Identity;
	peers: PeerStore;
	services: HostServices;
	name: () => string;
	/** This computer's tailnet addresses: the only ones it listens on. None = not listening (Tailscale is down). */
	bindHosts: () => Promise<string[]>;
	/** First port tried; defaults to `OMP_GUI_REMOTE_PORT` or 47821, then its successors (address.ts). */
	port?: number;
	/** Decide who connects, from the peer's address (`::ffff:` already stripped). */
	gate: (ip: string) => Promise<GateResult>;
	/** A device the host never saw: may it be recorded? Resolves false to refuse it `declined`. */
	admit: (visitor: TailnetVisitor, name: string) => Promise<boolean>;
	appVersion: string;
	hello: () => HostMachineInfo;
	/**
	 * A device asked to rename this computer (`host.rename`). Applies and announces the name, or throws a coded
	 * error the device shows.
	 */
	renameSelf?: (name: string, by: PeerInfo) => void;
	/** Something worth a line in the runtime log (a port other than the first, a refusal). */
	log?: (event: string, details: Record<string, unknown>) => void;
	/**
	 * A device's connection opened or closed (`open`, `closed` with why and how long), or moved a lot in the last
	 * minute (`traffic`: bytes and frames by kind, never a payload), for the runtime log (`remote-link`).
	 */
	logLink?: (event: "open" | "closed" | "traffic", details: Record<string, unknown>) => void;
	now?: () => number;
}

export type RemoteHostEvent = "peersChanged" | "connectionsChanged" | "listenChanged";

/** The slim capabilities a connection has, as one line for the log (`none` for a device that reads whole frames). */
function slimNames(conn: PeerConnection): string {
	const names = [conn.slimEvents && "events", conn.slimProgress && "progress", conn.slimAutopilot && "autopilot"];
	return names.filter(Boolean).join(",") || "none";
}

class PeerConnection implements HostConnection {
	readonly link: Link;
	peer: PeerInfo;
	readonly slimEvents: boolean;
	readonly slimProgress: boolean;
	readonly slimAutopilot: boolean;

	constructor(link: Link, peer: PeerInfo, slim: { events: boolean; progress: boolean; autopilot: boolean }) {
		this.link = link;
		this.peer = peer;
		this.slimEvents = slim.events;
		this.slimProgress = slim.progress;
		this.slimAutopilot = slim.autopilot;
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

function listen(server: Server, port: number, host: string): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	server.once("error", reject);
	server.listen(port, host, () => {
		server.off("error", reject);
		resolve((server.address() as AddressInfo).port);
	});
	return promise;
}

function close(server: Server): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	return promise;
}

function addressInUse(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}

export class RemoteHost {
	readonly #opts: RemoteHostOptions;
	readonly #now: () => number;
	readonly #emitter = new EventEmitter();
	readonly #links = new Set<Link>();
	readonly #connections = new Set<PeerConnection>();
	#servers: Server[] = [];
	#bound: string[] = [];
	#port: number | null = null;
	#listenError: ListenError | null = null;
	#running = false;
	#binding: Promise<void> | null = null;
	#loggedPort: number | null = null;

	constructor(opts: RemoteHostOptions) {
		this.#opts = opts;
		this.#now = opts.now ?? Date.now;
	}

	/** The listening TCP port, or null while not listening. */
	get port(): number | null {
		return this.#port;
	}

	/** Why it listens nowhere although started with tailnet addresses; null otherwise. */
	get listenError(): ListenError | null {
		return this.#listenError;
	}

	/** Listen on the tailnet addresses; the integration calls `rebind` when they may have changed. */
	async start(): Promise<void> {
		this.#running = true;
		await this.rebind();
	}

	/**
	 * Listen on exactly the current tailnet addresses (Tailscale came up, went down, or the address changed), or
	 * try the ports again after they were all taken. Concurrent calls share one pass.
	 */
	rebind(): Promise<void> {
		this.#binding ??= this.#rebind().finally(() => {
			this.#binding = null;
		});
		return this.#binding;
	}

	async #rebind(): Promise<void> {
		if (!this.#running) return;
		const wanted = [...new Set(await this.#opts.bindHosts().catch(() => []))].sort();
		if (!this.#running) return;
		const same = wanted.length === this.#bound.length && wanted.every((host, i) => host === this.#bound[i]);
		if (same && (this.#servers.length > 0 || wanted.length === 0)) return;
		await this.#closeServers();
		this.#listenError = null;
		if (wanted.length > 0) await this.#listenOn(wanted);
		this.#emitter.emit("listenChanged");
	}

	/** The first candidate port free on every address; the same port everywhere, so a device probes one list. */
	async #listenOn(hosts: string[]): Promise<void> {
		const candidates = this.#opts.port === undefined ? remotePortCandidates() : remotePortCandidates(this.#opts.port);
		for (const candidate of candidates) {
			const servers: Server[] = [];
			let port = candidate;
			try {
				for (const host of hosts) {
					const server = createServer(socket => this.#accept(socket));
					servers.push(server);
					// Port 0 (tests): the first address picks, the others follow it.
					port = await listen(server, port, host);
				}
			} catch (error) {
				await Promise.all(servers.map(server => (server.listening ? close(server) : Promise.resolve())));
				if (addressInUse(error)) continue;
				// Not a busy port (the address left this computer meanwhile): the next rebind tries again.
				this.#opts.log?.("listen-failed", { message: error instanceof Error ? error.message : String(error) });
				return;
			}
			this.#servers = servers;
			this.#bound = hosts;
			this.#port = port;
			if (candidate !== candidates[0] && this.#loggedPort !== port) {
				this.#loggedPort = port;
				this.#opts.log?.("port", { port, wanted: candidates[0] });
			}
			return;
		}
		this.#listenError = { code: "port_in_use", ports: candidates };
	}

	async #closeServers(): Promise<void> {
		const servers = this.#servers;
		this.#servers = [];
		this.#bound = [];
		this.#port = null;
		await Promise.all(servers.map(close));
	}

	async stop(): Promise<void> {
		this.#running = false;
		await this.#binding?.catch(() => undefined);
		for (const link of [...this.#links]) link.destroy();
		await this.#closeServers();
		this.#listenError = null;
	}

	/** `ip:port` for each tailnet address it listens on. */
	addresses(): string[] {
		const port = this.#port;
		if (port === null) return [];
		return this.#bound.map(host => formatAddress({ host, port }));
	}

	/** Peers with at least one live authenticated connection. */
	connections(): PeerInfo[] {
		const peers = new Map<string, PeerInfo>();
		for (const conn of this.#connections) peers.set(conn.peer.deviceId, { ...conn.peer });
		return [...peers.values()];
	}

	/** Forget a device and drop its live connections. */
	async revoke(deviceId: string): Promise<void> {
		const removed = this.#opts.peers.remove(deviceId);
		this.drop(deviceId);
		if (removed) this.#emitter.emit("peersChanged");
	}

	/** Drop a device's live connections (it was blocked, or its login is no longer allowed). */
	drop(deviceId: string): void {
		for (const conn of [...this.#connections]) if (conn.peer.deviceId === deviceId) conn.link.destroy();
	}

	on(event: RemoteHostEvent, fn: () => void): void {
		this.#emitter.on(event, fn);
	}

	off(event: RemoteHostEvent, fn: () => void): void {
		this.#emitter.off(event, fn);
	}

	#accept(socket: Socket): void {
		const ip = (socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
		const acceptedAt = this.#now();
		const link = new Link(socket);
		this.#links.add(link);
		link.onClose(() => this.#links.delete(link));
		this.#handshake(link, ip, acceptedAt).catch(() => link.destroy());
	}

	#refuse(link: Link, t: "auth-fail" | "error", code: RefusalCode, ip: string): void {
		this.#opts.log?.("refused", { code, ip });
		link.send({ t, code });
		link.close();
	}

	async #handshake(link: Link, ip: string, acceptedAt: number): Promise<void> {
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
		const gate = await this.#opts.gate(ip);
		if (opening.data.t === "probe") {
			if (!gate.ok) return this.#refuse(link, "error", gate.code, ip);
			link.send({
				t: "probe-ok",
				deviceId: this.#opts.identity.deviceId,
				name: this.#opts.name(),
				appVersion: this.#opts.appVersion,
			});
			link.close();
			return;
		}
		const init = AuthInit.parse(first);
		if (!gate.ok) return this.#refuse(link, "auth-fail", gate.code, ip);
		const bound = await this.#bindDevice(init, gate.visitor);
		if (typeof bound === "string") return this.#refuse(link, "auth-fail", bound, ip);
		await this.#auth(link, init, bound, acceptedAt);
	}

	/**
	 * The device record for this connection, pinned per node: a node already holding another device or key is
	 * refused until that record is removed here, so nobody gets a fresh record (and quota) by changing keys. A
	 * record from a code-paired release (no node yet) binds to the first node it connects from with its old key.
	 */
	async #bindDevice(init: AuthInit, visitor: TailnetVisitor): Promise<PeerInfo | RefusalCode> {
		const { peers } = this.#opts;
		const conflict = (): boolean => {
			const held = peers.byNode(visitor.nodeId);
			return held !== undefined && (held.deviceId !== init.deviceId || held.staticPub !== init.staticPub);
		};
		if (conflict()) return "key_mismatch";
		const known = peers.get(init.deviceId);
		if (known) {
			if (known.staticPub !== init.staticPub) return "key_mismatch";
			if (known.nodeId !== null && known.nodeId !== visitor.nodeId) return "key_mismatch";
			if (known.nodeId === null) {
				const bound = peers.update(known.deviceId, { nodeId: visitor.nodeId, login: visitor.login });
				this.#emitter.emit("peersChanged");
				return bound ?? known;
			}
			return known;
		}
		if (!(await this.#opts.admit(visitor, init.name))) return "declined";
		// Another connection of this node may have been recorded while the user was asked.
		if (conflict() || peers.get(init.deviceId)) return "key_mismatch";
		const peer: PeerInfo = {
			deviceId: init.deviceId,
			name: init.name,
			staticPub: init.staticPub,
			nodeId: visitor.nodeId,
			login: visitor.login,
			pairedAt: this.#now(),
		};
		peers.put(peer);
		this.#emitter.emit("peersChanged");
		return peer;
	}

	/** Auth, host side: key agreement over both static and both ephemeral keys, then hellos. */
	async #auth(link: Link, init: AuthInit, peer: PeerInfo, acceptedAt: number): Promise<void> {
		const { identity, peers } = this.#opts;
		const eph = generateKeyPair();
		link.send({
			t: "auth-resp",
			deviceId: identity.deviceId,
			name: this.#opts.name(),
			ephPub: eph.publicKey,
			staticPub: identity.publicKey,
		});
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
		// Removed or blocked while the handshake ran.
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
		const slimEvents = hello.slimEvents === true;
		const conn = new PeerConnection(link, current, {
			events: slimEvents,
			progress: slimEvents && hello.slimProgress === true,
			autopilot: slimEvents && hello.slimAutopilot === true,
		});
		this.#connections.add(conn);
		const openedAt = this.#now();
		// The device's build and what it can read: a busy traffic line is read against them (whole frames to an older
		// device cost tens of times what slim ones do).
		this.#opts.logLink?.("open", {
			deviceId: current.deviceId,
			ms: openedAt - acceptedAt,
			appVersion: hello.appVersion,
			slim: slimNames(conn),
		});
		const { logLink } = this.#opts;
		if (logLink)
			logLinkTraffic(link, {
				now: this.#now,
				log: details => logLink("traffic", { deviceId: current.deviceId, ...details }),
			});
		link.onClose(() => {
			this.#opts.logLink?.("closed", {
				deviceId: current.deviceId,
				reason: link.closeReason ?? "closed",
				ms: this.#now() - openedAt,
			});
			this.#disconnected(conn);
		});
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
