/**
 * The host side (B) of remote devices: a TCP server on this computer's tailnet addresses only, that lets in the
 * devices Tailscale vouches for and serves their requests through `HostServices`. No Electron imports. The listener,
 * the handshake and the links run in the core (`crates/core/src/remote/host.rs`), which asks main at each decision:
 * `gate` (who connects), `bind` (the device record), `open` (the device's hello and the host's answer).
 *
 * Who may connect is decided per connection by `gate` (the integration asks `tailscale whois` about the peer's
 * address: an allowed login, a node that is not blocked). The first authenticated connection of a device pins its
 * static key to its Tailscale node; later ones must come from that node with that key. A node holds one device.
 */
import { EventEmitter } from "node:events";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import { core } from "../core/process";
import { DEVICE_RENAME_EVENT, HOST_NAME_EVENT, NAME_METHODS, NameParams } from "./app-protocol";
import type { Identity } from "./identity";
import type { PeerInfo, PeerStore } from "./peers-store";
import {
	ClientHello,
	type LinkSlim,
	type RefusalCode,
	SLIM_LOG_NAMES,
	slimOf,
	type TabHolder,
	tabHolderOf,
	WireRequest,
} from "./protocol";
import { Link, type Liveness, type WireMessage } from "./wire";

/** A rebind still running this long is logged once (`rebind-slow`), with the device links open meanwhile. */
const REBIND_SLOW_MS = 2_000;

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
	/** Tests: ports the system refuses, with the code it answers (`EACCES`), as Windows' excluded ranges do. */
	refusePorts?: Record<number, string>;
	/** Tests: the links' ping and dead timers, and how often the traffic line is written. */
	liveness?: Liveness;
	trafficMs?: number;
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
	/** A device's link opened: its computer is up now (this one may still be dialing it as a host). */
	peerOpened?: (deviceId: string) => void;
	now?: () => number;
}

export type RemoteHostEvent = "peersChanged" | "connectionsChanged" | "listenChanged";

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

/** The core's question at one step of a device connection's handshake (`remote.ask`). */
export interface HostAsk {
	call: number;
	kind: "gate" | "bind" | "open";
	host: number;
	link: number;
	ip?: string;
	init?: { deviceId: string; name: string; staticPub: string };
	visitor?: TailnetVisitor;
	deviceId?: string;
	hello?: unknown;
}

const hosts = new Map<number, RemoteHost>();
/**
 * Listens run one at a time in the order asked, as node's binds did: two hosts of one main (a test's two computers)
 * that start together take their ports in that order, never as the core's tasks happen to run.
 */
let listens: Promise<unknown> = Promise.resolve();
let nextHost = 0;
let routed = false;

/** The core's asks and log lines reach the host they name. */
function route(): void {
	if (routed) return;
	routed = true;
	const process = core();
	process.on("remote.ask", data => {
		const ask = data as HostAsk;
		const host = hosts.get(ask.host);
		const answer = (result: unknown) =>
			void process.call("remote.answer", { call: ask.call, result }).catch(() => undefined);
		if (!host) answer(ask.kind === "open" ? null : { code: "protocol" });
		else
			host.answerAsk(ask).then(answer, error => {
				console.warn(`[remote] ${ask.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
				answer(ask.kind === "open" ? null : { code: "protocol" });
			});
	});
	process.on("remote.log", data => {
		const { host, event, details } = data as { host: number; event: string; details: Record<string, unknown> };
		hosts.get(host)?.logged(event, details);
	});
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
	readonly #id = ++nextHost;
	readonly #connections = new Set<PeerConnection>();
	/** The tailnet addresses it was asked to listen on (a rebind with the same ones changes nothing). */
	#bound: string[] = [];
	/** Those it listens on now: the one devices dial, and the others that took the same port. */
	#listening: string[] = [];
	#port: number | null = null;
	#listenError: ListenError | null = null;
	#running = false;
	#binding: Promise<void> | null = null;
	/** What the last `listening`/`not-listening` line said: a rebind that ends the same writes nothing. */
	#loggedListen: string | null = null;
	/** Each connection in its handshake, by the core's link number: when it was taken in, and its device record. */
	readonly #arriving = new Map<number, { acceptedAt: number; peer?: PeerInfo }>();
	/** Each device link's device, until the core says the link ended (its last traffic line comes before that). */
	readonly #linkDevices = new Map<number, string>();

	constructor(opts: RemoteHostOptions) {
		this.#opts = opts;
		this.#now = opts.now ?? Date.now;
		route();
		hosts.set(this.#id, this);
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
		const began = this.#now();
		const slow = setTimeout(() => this.#opts.log?.("rebind-slow", { links: this.#connections.size }), REBIND_SLOW_MS);
		slow.unref?.();
		try {
			const wanted = [...new Set(await this.#opts.bindHosts().catch(() => []))].sort();
			if (!this.#running) return;
			const same = wanted.length === this.#bound.length && wanted.every((host, i) => host === this.#bound[i]);
			if (same && (this.#port !== null || wanted.length === 0)) return;
			await this.#listenOn(wanted);
			this.#logListen(wanted.length, this.#now() - began);
			this.#emitter.emit("listenChanged");
		} finally {
			clearTimeout(slow);
		}
	}

	/** Where it listens after a rebind that changed it, for the runtime log: ports and counts, never an address. */
	#logListen(wanted: number, ms: number): void {
		const port = this.#port;
		const links = this.#connections.size;
		const [message, details] =
			port === null
				? (["not-listening", { wanted }] as const)
				: (["listening", { port, addresses: this.#listening.length }] as const);
		const said = `${message} ${JSON.stringify(details)}`;
		if (said === this.#loggedListen) return;
		this.#loggedListen = said;
		this.#opts.log?.(message, { ...details, links, ms });
	}

	/**
	 * Stops listening, then listens on `hosts` (none: nowhere): the first candidate port free on the address devices
	 * dial (its IPv4 tailnet address, `#hostAddresses` in devices.ts), then the same port on the others where they
	 * take it. Links accepted on the old listeners stay open: the core never waits for them, which once held the
	 * rebind (and every later one) for as long as one device stayed connected, while the host listened nowhere.
	 */
	async #listenOn(hosts: string[]): Promise<void> {
		this.#bound = [];
		this.#listening = [];
		this.#port = null;
		this.#listenError = null;
		const params = {
			host: this.#id,
			identity: this.#opts.identity.deviceId,
			addresses: hosts,
			port: this.#opts.port,
			portSetting: process.env.OMP_GUI_REMOTE_PORT,
			appVersion: this.#opts.appVersion,
			traffic: this.#opts.logLink !== undefined,
			...(this.#opts.trafficMs !== undefined ? { trafficMs: this.#opts.trafficMs } : {}),
			...(this.#opts.liveness ? { liveness: this.#opts.liveness } : {}),
			...(this.#opts.refusePorts ? { refuse: this.#opts.refusePorts } : {}),
		};
		const asked = listens.then(() =>
			core().call<{ port: number | null; listening: string[]; listenError: ListenError | null }>(
				"remote.hostListen",
				params,
			),
		);
		listens = asked.catch(() => undefined);
		const { result } = await asked;
		this.#port = result.port;
		this.#listening = result.listening;
		this.#listenError = result.listenError;
		if (result.port !== null) this.#bound = hosts;
	}

	async stop(): Promise<void> {
		this.#running = false;
		await this.#binding?.catch(() => undefined);
		for (const conn of [...this.#connections]) conn.link.destroy();
		await core()
			.call("remote.hostStop", { host: this.#id })
			.catch(() => undefined);
		this.#arriving.clear();
		this.#bound = [];
		this.#listening = [];
		this.#port = null;
		this.#listenError = null;
		this.#loggedListen = null;
	}

	/** `ip:port` for each tailnet address it listens on. */
	addresses(): string[] {
		const port = this.#port;
		if (port === null) return [];
		return this.#listening.map(host => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`));
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

	/** A line the core wrote about this host's listener (`port`, `listen-skipped`, ...). */
	logged(event: string, details: Record<string, unknown>): void {
		this.#opts.log?.(event, details);
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

	/** The core's question at one step of a connection's handshake. */
	async answerAsk(ask: HostAsk): Promise<unknown> {
		if (ask.kind === "gate") {
			this.#arriving.set(ask.link, { acceptedAt: this.#now() });
			const gate = await this.#opts.gate(ask.ip ?? "");
			if (!gate.ok) return this.#refused(ask, gate.code);
			return { visitor: gate.visitor, name: this.#opts.name() };
		}
		if (ask.kind === "bind") {
			const bound = ask.init && ask.visitor ? await this.#bindDevice(ask.init, ask.visitor) : "protocol";
			if (typeof bound === "string") return this.#refused(ask, bound);
			const arriving = this.#arriving.get(ask.link);
			if (arriving) arriving.peer = bound;
			return { staticPub: bound.staticPub, name: this.#opts.name() };
		}
		return this.#open(ask);
	}

	#refused(ask: HostAsk, code: RefusalCode): { code: RefusalCode } {
		this.#arriving.delete(ask.link);
		this.#opts.log?.("refused", { code, ip: ask.ip ?? "" });
		return { code };
	}

	/**
	 * The device record for this connection, pinned per node: a node already holding another device or key is
	 * refused until that record is removed here, so nobody gets a fresh record (and quota) by changing keys. A
	 * record from a code-paired release (no node yet) binds to the first node it connects from with its old key.
	 */
	async #bindDevice(
		init: { deviceId: string; name: string; staticPub: string },
		visitor: TailnetVisitor,
	): Promise<PeerInfo | RefusalCode> {
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

	/**
	 * The device's hello arrived, encrypted: check it, answer the host's hello and take the connection. Null drops it
	 * (a hello this build cannot read, a device removed or blocked while the handshake ran).
	 */
	#open(ask: HostAsk): { hello: Record<string, unknown>; deflate: boolean; context: boolean } | null {
		const arriving = this.#arriving.get(ask.link);
		this.#arriving.delete(ask.link);
		const parsed = ClientHello.safeParse(ask.hello);
		const peer = arriving?.peer;
		if (!parsed.success || !peer || !this.#opts.peers.get(peer.deviceId)) return null;
		const hello = parsed.data;
		const { peers } = this.#opts;
		const answer = { appVersion: this.#opts.appVersion, name: this.#opts.name(), ...this.#opts.hello() };
		const current = peers.update(peer.deviceId, { name: hello.name, lastSeenAt: this.#now() }) ?? peer;
		const link = new Link(ask.link);
		const conn = new PeerConnection(link, current, slimOf(hello), hello.appVersion);
		this.#linkDevices.set(ask.link, current.deviceId);
		this.#connections.add(conn);
		const openedAt = this.#now();
		// The device's build and what it can read: a busy traffic line is read against them (whole frames to an older
		// device cost tens of times what slim ones do).
		this.#opts.logLink?.("open", {
			deviceId: current.deviceId,
			ms: openedAt - (arriving?.acceptedAt ?? openedAt),
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
		queueMicrotask(() => {
			this.#emitter.emit("peersChanged");
			this.#emitter.emit("connectionsChanged");
			this.#opts.peerOpened?.(current.deviceId);
		});
		return { hello: answer, deflate: conn.slim.deflate, context: conn.slim.deflateContext };
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
