/**
 * The host side (B) of remote devices, as main holds it: the device links the core's host took in, and every
 * request and event on them, served through `HostServices`. No Electron imports. The listener on this computer's
 * tailnet addresses, its rebind, the handshake, who may connect (`gate`) and which device a node holds (`bind`) are
 * the core's devices instance's (`crates/core/src/remote/devices/`); main answers the device's hello (`open`), which
 * makes the link one of this host's connections.
 */
import { EventEmitter } from "node:events";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import { core } from "../core/process";
import { DEVICE_RENAME_EVENT, HOST_NAME_EVENT, NAME_METHODS, NameParams } from "./app-protocol";
import { type CoreAsk, onCoreAsk } from "./core-asks";
import type { PeerInfo } from "./peers-store";
import {
	ClientHello,
	type LinkSlim,
	SLIM_LOG_NAMES,
	slimOf,
	type TabHolder,
	tabHolderOf,
	WireRequest,
} from "./protocol";
import type { SharingCore } from "./sharing";
import { Link, type WireMessage } from "./wire";

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
	/** What the device reads beyond whole frames (`slimOf`, protocol.ts); absent for an older device. */
	readonly slim?: LinkSlim;
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

/** Why the host listens nowhere (`port_in_use`: every candidate port is taken on a tailnet address). */
export interface ListenError {
	code: "port_in_use";
	ports: number[];
}

export interface RemoteHostOptions {
	/** The core's devices instance this host is the main side of (its listener, gate and records). */
	sharing: SharingCore;
	services: HostServices;
	name: () => string;
	appVersion: string;
	hello: () => HostMachineInfo;
	/**
	 * A device asked to rename this computer (`host.rename`). Applies and announces the name, or throws a coded
	 * error the device shows.
	 */
	renameSelf?: (name: string, by: PeerInfo) => void;
	/**
	 * A device's connection opened or closed (`open`, `closed` with why and how long), or moved a lot in the last
	 * minute (`traffic`: bytes and frames by kind, never a payload), for the runtime log (`remote-link`).
	 */
	logLink?: (event: "open" | "closed" | "traffic", details: Record<string, unknown>) => void;
	now?: () => number;
}

export type RemoteHostEvent = "peersChanged" | "connectionsChanged";

/** The slim capabilities a connection has, as one line for the log (`none` for a device that reads whole frames). */
function slimNames(slim: LinkSlim): string {
	const names = (Object.keys(SLIM_LOG_NAMES) as Array<keyof LinkSlim>).filter(key => slim[key]);
	return names.map(key => SLIM_LOG_NAMES[key]).join(",") || "none";
}

class PeerConnection implements HostConnection {
	readonly link: Link;
	peer: PeerInfo;
	readonly slim: LinkSlim;
	/** The device's OMPdesk version, from its hello. */
	readonly appVersion: string;

	constructor(link: Link, peer: PeerInfo, slim: LinkSlim, appVersion: string) {
		this.link = link;
		this.peer = peer;
		this.appVersion = appVersion;
		this.slim = slim;
	}

	emit(event: string, data: unknown): void {
		this.link.send({ t: "evt", event, data });
	}

	close(): void {
		this.link.close();
	}
}

/** `{code, message}` for a failed call: a `[code]` marker, else the error's own string code; `holder` when it names one. */
function errorPayload(error: unknown): { code: string; message: string; holder?: TabHolder } {
	const message = error instanceof Error ? error.message : String(error);
	const own =
		typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
			? error.code
			: undefined;
	const holder = tabHolderOf(error);
	return { code: ipcErrorCode(error) ?? own ?? "remote_error", message, ...(holder ? { holder } : {}) };
}

/** The core's question when a device's hello arrived (`remote.ask` `open`). */
export interface HostAsk extends CoreAsk {
	kind: "open";
	host: number;
	link: number;
	deviceId: string;
	hello: unknown;
	/** The device record the core bound this connection to. */
	peer: PeerInfo;
	/** From taking the connection in to its hello. */
	waitedMs: number;
}

const hosts = new Map<number, RemoteHost>();
let routed = false;

/** The core's `open` asks, traffic lines and link ends reach the host they name. */
function route(): void {
	if (routed) return;
	routed = true;
	const process = core();
	onCoreAsk("open", ask => hosts.get(ask.host as number)?.answerAsk(ask as HostAsk) ?? null);
	process.on("remote.traffic", data => {
		const { link, details } = data as { link: number; details: Record<string, unknown> };
		for (const host of hosts.values()) host.traffic(link, details);
	});
	// After its last traffic line: a link this side destroyed still says what it carried.
	process.on("remote.closed", data => {
		for (const host of hosts.values()) host.forgetLink((data as { link: number }).link);
	});
}

export class RemoteHost {
	readonly #opts: RemoteHostOptions;
	readonly #now: () => number;
	readonly #emitter = new EventEmitter();
	readonly #id: number;
	readonly #connections = new Set<PeerConnection>();
	/** Each device link's device, until the core says the link ended (its last traffic line comes before that). */
	readonly #linkDevices = new Map<number, string>();

	constructor(opts: RemoteHostOptions) {
		this.#opts = opts;
		this.#now = opts.now ?? Date.now;
		this.#id = opts.sharing.id;
		route();
		hosts.set(this.#id, this);
	}

	/** The listening TCP port, or null while not listening. */
	get port(): number | null {
		return this.#opts.sharing.snapshot.host.port;
	}

	/** Why it listens nowhere although started with tailnet addresses; null otherwise. */
	get listenError(): ListenError | null {
		return this.#opts.sharing.snapshot.host.listenError;
	}

	/** Listen on the tailnet addresses (the core's devices instance rebinds when they change). */
	start(): Promise<void> {
		return this.#opts.sharing.setHost(true);
	}

	/** Listen on exactly the current tailnet addresses, or try the ports again; concurrent calls share one pass. */
	rebind(): Promise<void> {
		return this.#opts.sharing.rebind();
	}

	/** Stop listening and end every device's connection. */
	async stop(): Promise<void> {
		for (const conn of [...this.#connections]) conn.link.destroy();
		await this.#opts.sharing.setHost(false).catch(() => undefined);
	}

	/** `ip:port` for each tailnet address it listens on. */
	addresses(): string[] {
		return this.#opts.sharing.snapshot.host.addresses;
	}

	/** Peers with at least one live authenticated connection, with the OMPdesk version their newest one runs. */
	connections(): Array<PeerInfo & { appVersion: string }> {
		const peers = new Map<string, PeerInfo & { appVersion: string }>();
		for (const conn of this.#connections)
			peers.set(conn.peer.deviceId, { ...conn.peer, appVersion: conn.appVersion });
		return [...peers.values()];
	}

	/** Forget a device and drop its live connections. */
	async revoke(deviceId: string): Promise<void> {
		this.drop(deviceId);
		if (await this.#opts.sharing.revoke(deviceId)) this.#emitter.emit("peersChanged");
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

	/** A device link's traffic line, if the link is one of this host's. */
	traffic(link: number, details: Record<string, unknown>): void {
		const deviceId = this.#linkDevices.get(link);
		if (deviceId !== undefined) this.#opts.logLink?.("traffic", { deviceId, ...details });
	}

	/** The core ended the link: no more lines come for it. */
	forgetLink(link: number): void {
		this.#linkDevices.delete(link);
	}

	/** The core's `open` ask: a device's hello arrived. */
	async answerAsk(ask: HostAsk): Promise<unknown> {
		return this.#open(ask);
	}

	/**
	 * The device's hello arrived, encrypted: check it, answer the host's hello and take the connection. Null drops it
	 * (a hello this build cannot read, a device removed or blocked while the handshake ran).
	 */
	#open(ask: HostAsk): {
		hello: Record<string, unknown>;
		deflate: boolean;
		context: boolean;
		deviceName: string;
	} | null {
		const parsed = ClientHello.safeParse(ask.hello);
		if (!parsed.success) return null;
		const hello = parsed.data;
		const answer = { appVersion: this.#opts.appVersion, name: this.#opts.name(), ...this.#opts.hello() };
		// The core writes the same name and when it was seen into the record once it has this answer.
		const current: PeerInfo = { ...ask.peer, name: hello.name, lastSeenAt: this.#now() };
		const link = new Link(ask.link);
		const conn = new PeerConnection(link, current, slimOf(hello), hello.appVersion);
		this.#linkDevices.set(ask.link, current.deviceId);
		this.#connections.add(conn);
		const openedAt = this.#now();
		// The device's build and what it can read: a busy traffic line is read against them (whole frames to an older
		// device cost tens of times what slim ones do).
		this.#opts.logLink?.("open", {
			deviceId: current.deviceId,
			ms: ask.waitedMs,
			appVersion: conn.appVersion,
			slim: slimNames(conn.slim),
		});
		link.onClose(() => {
			this.#opts.logLink?.("closed", {
				deviceId: conn.peer.deviceId,
				reason: link.closeReason ?? "closed",
				ms: this.#now() - openedAt,
			});
			this.#disconnected(conn);
		});
		link.listen(message => this.#onMessage(conn, message));
		// Told once the core has the answer: the hello goes out before anything else on the link.
		queueMicrotask(() => this.#emitter.emit("connectionsChanged"));
		return {
			hello: answer,
			deflate: conn.slim.deflate,
			context: conn.slim.deflateContext,
			deviceName: hello.name,
		};
	}

	#disconnected(conn: PeerConnection): void {
		this.#connections.delete(conn);
		this.#opts.services.disconnected(conn.peer, conn);
		this.#emitter.emit("connectionsChanged");
	}

	#onMessage(conn: PeerConnection, message: WireMessage): void {
		// Unknown message types are ignored so a newer client can add some.
		const request = WireRequest.safeParse(message);
		if (!request.success) return;
		const { id, method, params } = request.data;
		if (method === NAME_METHODS.peerName || method === NAME_METHODS.hostRename) {
			void this.#serveName(conn, id, method, params);
			return;
		}
		void this.#serve(conn, id, method, params);
	}

	/** The device names itself (`peer.name`), or renames this computer (`host.rename`). */
	async #serveName(conn: PeerConnection, id: number, method: string, params: unknown): Promise<void> {
		let reply: object;
		try {
			const parsed = NameParams.safeParse(params);
			if (!parsed.success) throw codedError("invalid_name", "Invalid device name");
			const { name } = parsed.data;
			if (method === NAME_METHODS.peerName) {
				const updated = await this.#opts.sharing.peerName(conn.peer.deviceId, name);
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
