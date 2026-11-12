/**
 * Host ↔ client over real sockets on 127.0.0.1, with per-test temp userData directories. The host is the core's
 * devices instance (`SharingCore`) with main's `RemoteHost`; its Tailscale is the rig's: `gate` says who `whois`
 * names at the device's address and what Mobile web's list and blocks say of it (devices.test.ts runs the same
 * through `RemoteDevices`).
 *
 * Every listener here binds 127.0.0.1 itself. A host on `::` with an ephemeral port shared it with IPv4 listeners
 * of other processes on this Mac (a Logitech plug-in's 127.0.0.1:P, Tailscale's *:P), which took the 127.0.0.1
 * dials: the test hung until a 5 s connect or 10 s handshake deadline, past its own 5 s. An address nobody answers
 * is a listener held open that drops every connection, never a closed port another process can pick up.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import { advanceCoreTimers, fakeCoreTimers, realCoreTimers } from "../core/test-clock";
import { normalizeRuntimeErrorReport } from "../runtime-log-core";
import type { TailscaleStatus } from "../tailscale/status";
import {
	connectFirst,
	type LinkState,
	probeAny,
	probeHost,
	RemoteClient,
	type RemoteClientOptions,
	RemoteError,
} from "./client";
import { type HostServices, RemoteHost, type TailnetVisitor } from "./host-server";
import type { PairedHost } from "./hosts-store";
import { type Identity, loadIdentity } from "./identity";
import type { RefusalCode } from "./protocol";
import { SharingCore, type SharingOptions } from "./sharing";
import {
	authKeys,
	dh,
	generateKeyPair,
	Link as LegacyLink,
	legacyIdentity,
	legacyTranscript,
} from "./test-legacy-peer";
import { freePortRun } from "./test-ports";
import { hostStore, peerStore } from "./test-stores";
import { WAKE_CHECK_MS } from "./wire";

const APP_VERSION = "0.10.0";
const MACHINE = { platform: "darwin", ompVersion: "18.7.0", home: "/Users/b", sep: "/" };
const LOOPBACK = "127.0.0.1";
const LOGIN = "me@example.com";
/**
 * A tailnet address no computer here has (the core listens only on tailnet addresses, so the rig's absent one is one
 * of those): binding it fails `EADDRNOTAVAIL`.
 */
const ABSENT_TAILNET = "fd7a:115c:a1e0::ffff:ffff";

interface Side {
	dir: string;
	identity: Identity;
}

const dirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

async function side(): Promise<Side> {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-remote-"));
	dirs.push(dir);
	return { dir, identity: await loadIdentity(dir) };
}

const services: HostServices = {
	async call(_peer, method, params, conn) {
		if (method === "echo") return params;
		if (method === "push") {
			conn.emit("pushed", params);
			return "sent";
		}
		if (method === "coded") throw codedError("remote_offline", "coded failure");
		throw Object.assign(new Error(`unknown method ${method}`), { code: "no_method" });
	},
	disconnected() {},
};

/** What the rig's Tailscale and Mobile web say of a connection: who it is, or why it is refused. */
type GateResult = { ok: true; visitor: TailnetVisitor } | { ok: false; code: RefusalCode };

function visitor(nodeId = "nLAPTOP", login = LOGIN): GateResult {
	return { ok: true, visitor: { nodeId, login, nodeName: "laptop", ip: LOOPBACK } };
}

interface HostRig {
	b: Side;
	peers: ReturnType<typeof peerStore>;
	host: RemoteHost;
	port: number;
	/** Who Tailscale says connects; tests change it. */
	gate: { next: (ip: string) => GateResult };
	/** Whether the person approves a new device, and who was asked about. */
	admit: { answer: boolean; asked: TailnetVisitor[] };
	/** This computer's tailnet addresses; `hold` keeps a rebind waiting on them. */
	addresses: { hosts: string[]; hold: Promise<void> | null };
}

/**
 * The rig's Tailscale and Mobile web: `gate.next(ip)` decides what `whois` names at the address and what the list
 * and blocks say. A refusal is made the way the core meets it: `not_tailnet` an address that is no tailnet one (the
 * rig stops counting loopback as one when the test sets it), `no_identity` no whois answer, `not_allowed` a login off
 * the list, `blocked` a blocked node.
 */
function rigTailscale(
	gate: HostRig["gate"],
	addresses: HostRig["addresses"],
): Pick<SharingOptions, "tailnet" | "policy"> {
	const status = async (): Promise<TailscaleStatus> => {
		await addresses.hold;
		return { backend: "running", login: LOGIN, selfIps: addresses.hosts, peers: [] } as unknown as TailscaleStatus;
	};
	return {
		tailnet: {
			status,
			phase: async () => "ready",
			whois: async ip => {
				const next = gate.next(ip);
				if (next.ok)
					return { nodeId: next.visitor.nodeId, nodeName: next.visitor.nodeName, login: next.visitor.login };
				if (next.code === "no_identity") return null;
				return {
					nodeId: "nLAPTOP",
					nodeName: "laptop",
					login: next.code === "not_allowed" ? "other@example.com" : LOGIN,
				};
			},
		},
		policy: () => {
			const next = gate.next(LOOPBACK);
			return {
				allowedUsers: next.ok ? [next.visitor.login] : [LOGIN],
				blocked: !next.ok && next.code === "blocked",
			};
		},
	};
}

/** The rig's `gate`: setting `next` to a `not_tailnet` verdict makes the core stop counting loopback as the tailnet. */
function rigGate(sharing: () => SharingCore | null): HostRig["gate"] {
	let next = (_ip: string) => visitor();
	return {
		get next() {
			return next;
		},
		set next(verdict) {
			next = verdict;
			const said = verdict(LOOPBACK);
			sharing()?.configure({ loopback: said.ok || said.code !== "not_tailnet" });
		},
	};
}

async function startHost(
	given?: Side,
	port = 0,
	bindHosts = [LOOPBACK],
	logLink?: (event: "open" | "closed" | "traffic", details: Record<string, unknown>) => void,
	options: Partial<SharingOptions> = {},
	log?: SharingOptions["log"],
): Promise<HostRig> {
	const b = given ?? (await side());
	let opened: SharingCore | null = null;
	const gate = rigGate(() => opened);
	const admit = { answer: true, asked: [] as TailnetVisitor[] };
	const addresses = { hosts: bindHosts, hold: null as Promise<void> | null };
	const sharing = await SharingCore.open({
		identity: b.identity,
		userData: b.dir,
		appVersion: APP_VERSION,
		name: "Studio",
		loopback: true,
		port,
		traffic: logLink !== undefined,
		migratedAt: 0,
		...rigTailscale(gate, addresses),
		admit: async seen => {
			admit.asked.push(seen);
			return admit.answer;
		},
		...(log ? { log } : {}),
		...options,
	});
	opened = sharing;
	const host = new RemoteHost({
		sharing,
		services,
		name: () => "Studio",
		appVersion: APP_VERSION,
		hello: () => MACHINE,
		logLink,
	});
	await host.start();
	cleanups.push(async () => {
		await host.stop();
		await sharing.dispose();
	});
	return { b, peers: peerStore(b.dir), host, port: host.port ?? 0, gate, admit, addresses };
}

async function connectedClient(
	rig: HostRig,
	given?: Side,
	nodeId = "nSTUDIO",
): Promise<{ a: Side; hosts: ReturnType<typeof hostStore>; paired: PairedHost }> {
	const a = given ?? (await side());
	const hosts = hostStore(a.dir);
	const paired = await connectFirst({
		identity: a.identity,
		address: `${LOOPBACK}:${rig.port}`,
		name: "Laptop",
		appVersion: APP_VERSION,
		nodeId,
		userData: a.dir,
	});
	return { a, hosts, paired };
}

function client(
	a: Side,
	paired: PairedHost,
	hosts?: ReturnType<typeof hostStore>,
	log?: RemoteClientOptions["log"],
): RemoteClient {
	const remote = new RemoteClient({
		identity: a.identity,
		host: paired,
		appVersion: APP_VERSION,
		name: () => "Laptop",
		...(hosts ? { userData: a.dir } : {}),
		log,
	});
	cleanups.push(() => remote.close());
	return remote;
}

interface LinkLine {
	message: string;
	details: Record<string, unknown>;
}

/** Everything a client or host wrote to the runtime log's `remote-link` source. */
function linkLog(): { lines: LinkLine[]; log: (message: string, details: Record<string, unknown>) => void } {
	const lines: LinkLine[] = [];
	return { lines, log: (message, details) => lines.push({ message, details }) };
}

/** Fake timers, main's and the core's, that leave `setImmediate` and the sockets alone: a link's real I/O still runs. */
function fakeLinkClock(): Promise<void> {
	return fakeCoreTimers(["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]);
}

/** Let the retry timer fire after `delayMs`, then wait for that attempt to fail. */
async function failedRetry(remote: RemoteClient, delayMs: number): Promise<void> {
	await advanceCoreTimers(delayMs);
	await untilState(remote, "offline");
}

/** Resolve once `done()` holds after a state change; the timer is only a failure deadline. */
function until(remote: RemoteClient, done: () => boolean, timeoutMs: number): Promise<void> {
	if (done()) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		remote.off("state", onState);
		reject(new Error(`gave up in state ${remote.state} (error ${remote.error})`));
	}, timeoutMs);
	const onState = () => {
		if (!done()) return;
		clearTimeout(timer);
		remote.off("state", onState);
		resolve();
	};
	remote.on("state", onState);
	return promise;
}

function untilState(remote: RemoteClient, wanted: LinkState, timeoutMs = 5_000): Promise<void> {
	return until(remote, () => remote.state === wanted, timeoutMs);
}

/** The error `remote` settles offline with (not a drop's error-free offline). */
async function untilError(remote: RemoteClient, timeoutMs = 5_000): Promise<string | null> {
	await until(remote, () => remote.state === "offline" && remote.error !== null, timeoutMs);
	return remote.error;
}

async function rejection(promise: Promise<unknown>): Promise<RemoteError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RemoteError) return error;
		throw error;
	}
	throw new Error("expected a rejection");
}

/** A link as a released (TypeScript) peer speaks it, dialed to `port`. */
function dialLink(port: number): Promise<LegacyLink> {
	const socket = connect({ host: LOOPBACK, port });
	const { promise, resolve, reject } = Promise.withResolvers<LegacyLink>();
	socket.once("error", reject);
	socket.once("connect", () => resolve(new LegacyLink(socket)));
	cleanups.push(() => {
		socket.destroy();
	});
	return promise;
}

function listenFake(onSocket: (socket: Socket) => void, port = 0): Promise<{ server: Server; port: number }> {
	const server = createServer(onSocket);
	const { promise, resolve, reject } = Promise.withResolvers<{ server: Server; port: number }>();
	server.once("error", reject);
	server.listen(port, LOOPBACK, () => resolve({ server, port: (server.address() as AddressInfo).port }));
	cleanups.push(() => {
		server.close();
	});
	return promise;
}

/**
 * Hold `count` consecutive free ports with listeners that drop every connection; `release(i)` frees port i. The run
 * sits below the ephemeral range (`freePortRun`): a parallel worker's `listen(0)` would otherwise take a released
 * port of it before the host under test does.
 */
async function heldRun(count: number): Promise<{ base: number; release: (index: number) => Promise<void> }> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const base = await freePortRun(count);
		const servers: Server[] = [];
		try {
			for (let i = 0; i < count; i++) servers.push((await listenFake(socket => socket.destroy(), base + i)).server);
		} catch {
			// Taken by another process meanwhile: try another run (the held ones close with the test).
			continue;
		}
		const release = (index: number): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			const server = servers[index];
			if (!server?.listening) return Promise.resolve();
			server.close(() => resolve());
			return promise;
		};
		return { base, release };
	}
	throw new Error("no run of free ports");
}

beforeEach(() => {
	dirs.length = 0;
});

afterEach(async () => {
	await realCoreTimers();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("first contact, gated by Tailscale", () => {
	it("pins each side to the other's key and the device to its node, with no code", async () => {
		const rig = await startHost();
		const probe = await probeHost(`${LOOPBACK}:${rig.port}`);
		expect(probe).toEqual({ ok: true, deviceId: rig.b.identity.deviceId, name: "Studio", appVersion: APP_VERSION });
		const { a, paired } = await connectedClient(rig);

		expect(paired).toMatchObject({
			deviceId: rig.b.identity.deviceId,
			name: "Studio",
			staticPub: rig.b.identity.publicKey,
			nodeId: "nSTUDIO",
			addresses: [`${LOOPBACK}:${rig.port}`],
		});
		expect(await hostStore(a.dir).get(rig.b.identity.deviceId)).toEqual(paired);
		expect(await peerStore(rig.b.dir).get(a.identity.deviceId)).toMatchObject({
			deviceId: a.identity.deviceId,
			name: "Laptop",
			staticPub: a.identity.publicKey,
			nodeId: "nLAPTOP",
			login: "me@example.com",
		});
	});

	it("refuses whoever Tailscale does not vouch for, tells a probe only why, and records nothing", async () => {
		const rig = await startHost();
		for (const code of ["not_tailnet", "no_identity", "not_allowed", "blocked"] as const) {
			rig.gate.next = () => ({ ok: false, code });
			expect(await probeHost(`${LOOPBACK}:${rig.port}`)).toEqual({ ok: false, code });
			expect((await rejection(connectedClient(rig))).code).toBe(code);
		}
		expect(await rig.peers.list()).toEqual([]);
		expect(rig.admit.asked).toEqual([]);
	});

	it("asks about a new device only, and refuses it declined when the person says no", async () => {
		const rig = await startHost();
		rig.admit.answer = false;
		expect((await rejection(connectedClient(rig))).code).toBe("declined");
		expect(await rig.peers.list()).toEqual([]);
		rig.admit.answer = true;
		const { a, hosts, paired } = await connectedClient(rig);
		expect(rig.admit.asked.map(seen => seen.nodeId)).toEqual(["nLAPTOP", "nLAPTOP"]);
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		expect(rig.admit.asked).toHaveLength(2);
	});

	it("keeps a node to one device and one key: a new identity from the same node is refused", async () => {
		const rig = await startHost();
		const { a } = await connectedClient(rig);
		const pins = async () => (await rig.peers.list()).map(peer => [peer.deviceId, peer.nodeId, peer.staticPub]);
		const before = await pins();
		// Same Tailscale node, a fresh OMPdesk identity (new device id and key): no new record, no new quota.
		expect((await rejection(connectedClient(rig))).code).toBe("key_mismatch");
		expect(await pins()).toEqual(before);
		expect(before).toEqual([[a.identity.deviceId, "nLAPTOP", a.identity.publicKey]]);
		// The known device from another node is refused too.
		rig.gate.next = () => visitor("nOTHER");
		expect((await rejection(connectedClient(rig, a))).code).toBe("key_mismatch");
		// Removing the device frees the node.
		rig.gate.next = () => visitor();
		await rig.host.revoke(a.identity.deviceId);
		await connectedClient(rig);
		expect(await rig.peers.list()).toHaveLength(1);
	});

	it("refuses a known device id that comes with another key", async () => {
		const rig = await startHost();
		const { a } = await connectedClient(rig);
		await rig.peers.update(a.identity.deviceId, { staticPub: generateKeyPair().publicKey });
		expect((await rejection(connectedClient(rig, a))).code).toBe("key_mismatch");
	});

	it("binds a device paired by code to the node it first connects from, keeping its limits", async () => {
		const rig = await startHost();
		const a = await side();
		await rig.peers.put({
			deviceId: a.identity.deviceId,
			name: "Laptop",
			staticPub: a.identity.publicKey,
			nodeId: null,
			login: null,
			pairedAt: 1,
			limits: { requestsPerDay: 5 },
		});
		await connectedClient(rig, a);
		expect(await rig.peers.get(a.identity.deviceId)).toMatchObject({
			nodeId: "nLAPTOP",
			login: "me@example.com",
			limits: { requestsPerDay: 5 },
		});
		expect(rig.admit.asked).toEqual([]);
	});

	it("the client refuses a host that answers with another key than the one it pinned", async () => {
		const rig = await startHost();
		const { a, paired } = await connectedClient(rig);
		const remote = client(a, { ...paired, staticPub: generateKeyPair().publicKey });
		remote.connect();
		expect(await untilError(remote)).toBe("key_mismatch");
		// And a first contact for a node pinned to another key fails the same way.
		await hostStore(a.dir).update(paired.deviceId, { staticPub: generateKeyPair().publicKey });
		expect((await rejection(connectedClient(rig, a))).code).toBe("key_mismatch");
	});

	it("reports an unreachable host", async () => {
		const { port } = await listenFake(socket => socket.destroy());
		expect((await rejection(probeHost(`${LOOPBACK}:${port}`))).code).toBe("unreachable");
	});
});

describe("listening", () => {
	it("listens only on the addresses it is given, and nowhere without them", async () => {
		const rig = await startHost();
		expect(rig.host.addresses()).toEqual([`${LOOPBACK}:${rig.port}`]);
		rig.addresses.hosts = [];
		await rig.host.rebind();
		expect(rig.host.port).toBeNull();
		expect(rig.host.addresses()).toEqual([]);
		expect(rig.host.listenError).toBeNull();
	});

	it("skips a port the system reserves as it skips a busy one (Windows answers EACCES for its excluded ranges)", async () => {
		const held = await heldRun(2);
		await held.release(0);
		await held.release(1);
		const base = held.base;
		const rig = await startHost(await side(), base, [LOOPBACK], undefined, { refusePorts: { [base]: "EACCES" } });
		expect(rig.host.port).toBe(base + 1);
		expect(rig.host.listenError).toBeNull();
	});

	it("listens on the address devices dial when another of its addresses cannot be bound", async () => {
		// A tailnet address this computer does not have: binding it fails as a Windows IPv6 tailnet address once did.
		const rig = await startHost(await side(), 0, [LOOPBACK, ABSENT_TAILNET]);
		expect(rig.host.port).not.toBeNull();
		expect(rig.host.addresses()).toEqual([`${LOOPBACK}:${rig.host.port}`]);
		expect((await probeHost(`${LOOPBACK}:${rig.host.port}`)).ok).toBe(true);
	});

	it("takes the next port of its list when the first is busy, and says so when all are", async () => {
		const one = await heldRun(5);
		for (const index of [1, 2, 3, 4]) await one.release(index);
		const base = one.base;
		const next = await startHost(await side(), base);
		expect(next.host.port).toBe(base + 1);
		await next.host.stop();

		const held = await heldRun(5);
		const all = held.base;
		const rig = await startHost(await side(), all);
		expect(rig.host.port).toBeNull();
		expect(rig.host.listenError).toEqual({ code: "port_in_use", ports: [all, all + 1, all + 2, all + 3, all + 4] });
		// A port coming free is taken on the next rebind (devices.ts runs one every 15 s).
		await held.release(0);
		await rig.host.rebind();
		expect(rig.host.port).toBe(all);
		expect(rig.host.listenError).toBeNull();
	});
});

describe("a host whose addresses change while a device is connected", () => {
	/** A host with one device online on it (its first contact already closed), and what the host logged. */
	async function linkedHost() {
		const { lines, log } = linkLog();
		const firstContactClosed = Promise.withResolvers<void>();
		// A port of its own list, as in use: listening again takes the same port while a link accepted on it is open.
		const rig = await startHost(
			await side(),
			await freePortRun(),
			[LOOPBACK],
			message => {
				if (message === "closed") firstContactClosed.resolve();
			},
			{},
			log,
		);
		const { a, hosts, paired } = await connectedClient(rig);
		await firstContactClosed.promise;
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		return { rig, remote, lines };
	}

	async function answers(rig: HostRig): Promise<boolean> {
		const port = rig.host.port;
		return port !== null && (await probeHost(`${LOOPBACK}:${port}`)).ok;
	}

	it("keeps the device's link and listens again on its port once its addresses come back", async () => {
		const { rig, remote } = await linkedHost();
		rig.addresses.hosts = [];
		await rig.host.rebind();
		expect(rig.host.port).toBeNull();

		rig.addresses.hosts = [LOOPBACK];
		await rig.host.rebind();

		expect(rig.host.port).toBe(rig.port);
		expect(await answers(rig)).toBe(true);
		expect(remote.state).toBe("online");
		expect(await remote.request("echo", "kept")).toBe("kept");
	});

	it("two rebinds in a row both settle, and the next one listens on what is wanted", async () => {
		const { rig } = await linkedHost();
		rig.addresses.hosts = [];
		const first = rig.host.rebind();
		rig.addresses.hosts = [LOOPBACK];
		const second = rig.host.rebind();
		await Promise.all([first, second]);

		await rig.host.rebind();

		expect(await answers(rig)).toBe(true);
	});

	it("an address it cannot bind leaves it listening nowhere until a rebind finds one it can", async () => {
		const { rig, remote, lines } = await linkedHost();
		// A tailnet address this computer does not have: binding it fails as an address that left this computer does.
		rig.addresses.hosts = [ABSENT_TAILNET];
		await rig.host.rebind();
		await rig.host.rebind();
		expect(rig.host.port).toBeNull();
		// Each poll tries again; only the first says it listens nowhere.
		expect(lines.filter(line => line.message === "not-listening")).toEqual([
			{ message: "not-listening", details: { wanted: 1, links: 1, ms: expect.any(Number) } },
		]);

		rig.addresses.hosts = [LOOPBACK];
		await rig.host.rebind();

		expect(await answers(rig)).toBe(true);
		expect(remote.state).toBe("online");
	});

	it("logs each change of its listener with how long the rebind took, and no address", async () => {
		const { rig, lines } = await linkedHost();
		const before = lines.length;
		rig.addresses.hosts = [];
		await rig.host.rebind();
		rig.addresses.hosts = [LOOPBACK];
		await rig.host.rebind();
		await rig.host.rebind();

		const ms = expect.any(Number);
		expect(lines.slice(before)).toEqual([
			{ message: "not-listening", details: { wanted: 0, links: 1, ms } },
			{ message: "listening", details: { port: rig.port, addresses: 1, links: 1, ms } },
		]);
	});

	it("logs a rebind still running after 2 s with how many device links are open", async () => {
		const { rig, lines } = await linkedHost();
		rig.addresses.hosts = [];
		await rig.host.rebind();
		await fakeLinkClock();
		const held = Promise.withResolvers<void>();
		rig.addresses.hold = held.promise;
		rig.addresses.hosts = [LOOPBACK];
		const pass = rig.host.rebind();

		await advanceCoreTimers(2_000);
		expect(lines.at(-1)).toEqual({ message: "rebind-slow", details: { links: 1 } });

		rig.addresses.hold = null;
		await realCoreTimers();
		held.resolve();
		await pass;
		expect(lines.at(-1)?.message).toBe("listening");
	});
});

describe("a host's ports, one of them silent", () => {
	// TEST-NET-1 belongs to no computer: a connect to it gets no answer, as a port a firewall drops does.
	const SILENT = "192.0.2.1:47821";

	it("connects on the next port when the first (the one it remembered) answers nothing", async () => {
		const rig = await startHost();
		const { a, paired } = await connectedClient(rig);
		// The record's own addresses, the silent one first (no store: the client dials what it was given).
		const remote = client(a, { ...paired, addresses: [SILENT, `${LOOPBACK}:${rig.port}`] });
		const started = Date.now();
		remote.connect();
		await untilState(remote, "online", 2_500);
		expect(Date.now() - started).toBeLessThan(2_500);
	});

	it("finds a host in the tailnet list behind a silent port", async () => {
		const rig = await startHost();
		const found = await probeAny([SILENT, `${LOOPBACK}:${rig.port}`]);
		expect(found.address).toBe(`${LOOPBACK}:${rig.port}`);
		expect(found.probe.ok).toBe(true);
	});

	it("prefers the earlier port when both answer", async () => {
		const first = await startHost();
		const second = await startHost();
		const found = await probeAny([`${LOOPBACK}:${first.port}`, `${LOOPBACK}:${second.port}`]);
		expect(found.address).toBe(`${LOOPBACK}:${first.port}`);
	});
});

describe("authenticated link", () => {
	it("round-trips requests and pushes events", async () => {
		const rig = await startHost();
		const { a, hosts, paired } = await connectedClient(rig);
		const remote = client(a, paired, hosts);
		const events: [string, unknown][] = [];
		remote.on("event", (event, data) => events.push([event, data]));
		remote.connect();
		await untilState(remote, "online");

		expect(remote.hello).toEqual({ protocol: 1, appVersion: APP_VERSION, name: "Studio", ...MACHINE });
		expect(rig.host.connections().map(peer => peer.deviceId)).toEqual([a.identity.deviceId]);
		expect(await remote.request("echo", { nested: [1, "two"] })).toEqual({ nested: [1, "two"] });
		expect(await remote.request("push", { n: 7 })).toBe("sent");
		expect(events).toEqual([["pushed", { n: 7 }]]);

		const coded = await rejection(remote.request("coded", null));
		expect(coded.code).toBe("remote_offline");
		expect(coded.message).toBe("[remote_offline] coded failure");
		expect((await rejection(remote.request("missing", null))).code).toBe("no_method");
	});

	it("rejects requests with remote_offline when not online", async () => {
		const rig = await startHost();
		const { a, paired } = await connectedClient(rig);
		const remote = client(a, paired);
		expect((await rejection(remote.request("echo", 1))).code).toBe("remote_offline");

		remote.connect();
		await untilState(remote, "online");
		await rig.host.stop();
		await untilState(remote, "offline");
		expect((await rejection(remote.request("echo", 1))).code).toBe("remote_offline");
	});

	it("a blocked node is dropped and refused on its next connection", async () => {
		const rig = await startHost();
		const { a, paired } = await connectedClient(rig);
		const remote = client(a, paired);
		remote.connect();
		await untilState(remote, "online");

		rig.gate.next = () => ({ ok: false, code: "blocked" });
		await rig.host.revoke(a.identity.deviceId);
		expect(rig.host.connections()).toEqual([]);
		expect(await rig.peers.get(a.identity.deviceId)).toBeUndefined();
		await untilState(remote, "offline");
		remote.connect();
		expect(await untilError(remote)).toBe("blocked");
	});

	it("closes the connection on a tampered ciphertext frame", async () => {
		const rig = await startHost();
		const { a, paired } = await connectedClient(rig);
		// A relay that flips the last byte (the GCM tag) of the next client chunk once armed.
		let armed = false;
		const relay = await listenFake(inbound => {
			const outbound = connect({ host: LOOPBACK, port: rig.port });
			inbound.on("data", chunk => {
				if (armed) {
					armed = false;
					chunk[chunk.length - 1] = (chunk[chunk.length - 1] ?? 0) ^ 0xff;
				}
				outbound.write(chunk);
			});
			outbound.on("data", chunk => inbound.write(chunk));
			inbound.on("close", () => outbound.destroy());
			outbound.on("close", () => inbound.destroy());
			inbound.on("error", () => {});
			outbound.on("error", () => {});
		});
		const remote = client(a, { ...paired, addresses: [`${LOOPBACK}:${relay.port}`] });
		remote.connect();
		await untilState(remote, "online");
		expect(await remote.request("echo", "clean")).toBe("clean");

		armed = true;
		const error = await rejection(remote.request("echo", "tampered"));
		expect(error.code).toBe("remote_offline");
		expect(rig.host.connections()).toEqual([]);
	});

	// Real time: the client's 1 s backoff runs against real sockets, which fake timers would stall.
	it("reconnects after the host restarts", async () => {
		const rig = await startHost();
		const { a, hosts, paired } = await connectedClient(rig);
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");

		await rig.host.stop();
		await untilState(remote, "offline");
		const restarted = await startHost(rig.b, rig.port);
		expect(restarted.port).toBe(rig.port);
		await untilState(remote, "online", 8_000);
		expect(await remote.request("echo", "back")).toBe("back");
	}, 15_000);

	it("tries each address and keeps the working one first", async () => {
		const rig = await startHost();
		const { a, hosts, paired } = await connectedClient(rig);
		const { port: dead } = await listenFake(socket => socket.destroy());
		const working = `${LOOPBACK}:${rig.port}`;
		await hosts.update(paired.deviceId, { addresses: [`${LOOPBACK}:${dead}`, working] });
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		expect((await hostStore(a.dir).get(paired.deviceId))?.addresses).toEqual([working, `${LOOPBACK}:${dead}`]);
	});
});

describe("a link that dropped or went silent", () => {
	/**
	 * The host goes away and something at its address drops every connection (a path that answers, an app that is
	 * not it): the client waits out 1, 2, 4 and 8 s of backoff with the next retry 16 s off.
	 */
	async function backedOff(log?: RemoteClientOptions["log"]) {
		const rig = await startHost();
		const { a, hosts, paired } = await connectedClient(rig);
		await fakeLinkClock();
		const remote = client(a, paired, hosts, log);
		remote.connect();
		await untilState(remote, "online");
		await rig.host.stop();
		const dropping = await listenFake(socket => socket.destroy(), rig.port);
		await untilState(remote, "offline");
		for (const delay of [1_000, 2_000, 4_000, 8_000]) await failedRetry(remote, delay);
		return { rig, remote, paired, dropping };
	}

	async function hostBack(rig: HostRig, dropping: Server): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		dropping.close(() => resolve());
		await promise;
		await startHost(rig.b, rig.port);
	}

	it("a wake connects at once, without waiting out the grown backoff", async () => {
		const { lines, log } = linkLog();
		const { rig, remote, paired, dropping } = await backedOff(log);
		await hostBack(rig, dropping.server);

		remote.wake("resume");
		await untilState(remote, "online");

		expect(lines.filter(line => line.message === "attempt").at(-1)?.details).toEqual({
			deviceId: paired.deviceId,
			n: 5,
			delayMs: 0,
			trigger: "resume",
			// The address answered and dropped the dial: the computer's app is not the one refusing.
			refused: false,
		});
	});

	it("a wake that finds the host still down starts the backoff over at 1 s", async () => {
		const { lines, log } = linkLog();
		const { remote, paired } = await backedOff(log);

		remote.wake("online");
		await untilState(remote, "offline");
		await failedRetry(remote, 1_000);

		expect(lines.filter(line => line.message === "attempt").slice(-2)).toEqual([
			{
				message: "attempt",
				details: { deviceId: paired.deviceId, n: 5, delayMs: 0, trigger: "online", refused: false },
			},
			{
				message: "attempt",
				details: { deviceId: paired.deviceId, n: 6, delayMs: 1_000, trigger: "backoff", refused: false },
			},
		]);
	});

	it("a wake drops a link that went silent within the wake check, not after the 30 s dead timer", async () => {
		const rig = await startHost();
		const { a, paired } = await connectedClient(rig);
		const silence = { on: false };
		const held = new Set<Socket>();
		const relay = await listenFake(inbound => {
			const outbound = connect({ host: LOOPBACK, port: rig.port });
			held.add(inbound).add(outbound);
			inbound.on("data", chunk => {
				if (!silence.on) outbound.write(chunk);
			});
			outbound.on("data", chunk => {
				if (!silence.on) inbound.write(chunk);
			});
			inbound.on("close", () => outbound.destroy());
			outbound.on("close", () => inbound.destroy());
			inbound.on("error", () => {});
			outbound.on("error", () => {});
		});
		cleanups.push(() => {
			for (const socket of held) socket.destroy();
		});
		await fakeLinkClock();
		const { lines, log } = linkLog();
		const remote = client(a, { ...paired, addresses: [`${LOOPBACK}:${relay.port}`] }, undefined, log);
		remote.connect();
		await untilState(remote, "online");
		await advanceCoreTimers(5_000);
		silence.on = true;

		remote.wake("focus");
		// The check runs in the core on its own clock; this side's clock moves by the same window.
		await advanceCoreTimers(WAKE_CHECK_MS);
		await until(remote, () => remote.state !== "online", 10_000);
		expect(lines.find(line => line.message === "down")?.details).toEqual({
			deviceId: paired.deviceId,
			name: "Studio",
			reason: "dead",
			wasOnlineMs: 5_000 + WAKE_CHECK_MS,
		});
	});

	it("the host's computer connecting to this one ends a dial still waiting on it and tries again at once", async () => {
		const rig = await startHost();
		const { a, paired } = await connectedClient(rig);
		// A restarting host: its port takes the connection and answers nothing until the app is back.
		const restarting = { on: true };
		const held = new Set<Socket>();
		const relay = await listenFake(inbound => {
			held.add(inbound);
			inbound.on("error", () => {});
			if (restarting.on) return;
			const outbound = connect({ host: LOOPBACK, port: rig.port });
			held.add(outbound);
			inbound.pipe(outbound).pipe(inbound);
			inbound.on("close", () => outbound.destroy());
			outbound.on("close", () => inbound.destroy());
			outbound.on("error", () => {});
		});
		cleanups.push(() => {
			for (const socket of held) socket.destroy();
		});
		const { lines, log } = linkLog();
		const remote = client(a, { ...paired, addresses: [`${LOOPBACK}:${relay.port}`] }, undefined, log);
		remote.connect();
		await untilState(remote, "connecting");
		await new Promise(resolve => setTimeout(resolve, 200));
		restarting.on = false;

		const woke = Date.now();
		remote.wake("peer");
		await untilState(remote, "online");

		// The held handshake would have waited out its 10 s before the next dial.
		expect(Date.now() - woke).toBeLessThan(3_000);
		expect(lines.filter(line => line.message === "attempt").map(line => line.details.trigger)).toEqual([
			"start",
			"peer",
		]);
	}, 15_000);

	it("logs an outage: down with the reason, each attempt, up with how long it lasted", async () => {
		const rig = await startHost();
		const { a, hosts, paired } = await connectedClient(rig);
		await fakeLinkClock();
		const { lines, log } = linkLog();
		const remote = client(a, paired, hosts, log);
		remote.connect();
		await untilState(remote, "online");
		await advanceCoreTimers(2_000);
		await rig.host.stop();
		const dropping = await listenFake(socket => socket.destroy(), rig.port);
		await untilState(remote, "offline");
		await failedRetry(remote, 1_000);
		await failedRetry(remote, 2_000);
		await hostBack(rig, dropping.server);
		await advanceCoreTimers(4_000);
		await untilState(remote, "online");

		const id = paired.deviceId;
		expect(lines).toEqual([
			{ message: "attempt", details: { deviceId: id, n: 1, delayMs: 0, trigger: "start" } },
			// Each "up" names the build the host runs, as the host's own "open" line names the device's.
			{ message: "up", details: { deviceId: id, outageMs: 0, attempts: 1, appVersion: APP_VERSION } },
			{ message: "down", details: { deviceId: id, name: "Studio", reason: "closed", wasOnlineMs: 2_000 } },
			{ message: "attempt", details: { deviceId: id, n: 1, delayMs: 1_000, trigger: "backoff" } },
			{ message: "attempt", details: { deviceId: id, n: 2, delayMs: 2_000, trigger: "backoff", refused: false } },
			{ message: "attempt", details: { deviceId: id, n: 3, delayMs: 4_000, trigger: "backoff", refused: false } },
			{ message: "up", details: { deviceId: id, outageMs: 7_000, attempts: 3, appVersion: APP_VERSION } },
		]);
	});

	/** The host's app quit (an update, a restart): its computer answers every dial with a refusal. */
	async function refused(log?: RemoteClientOptions["log"]) {
		const rig = await startHost();
		const { a, hosts, paired } = await connectedClient(rig);
		await fakeLinkClock();
		const remote = client(a, paired, hosts, log);
		remote.connect();
		await untilState(remote, "online");
		await rig.host.stop();
		await untilState(remote, "offline");
		return { rig, remote };
	}

	it("says on each attempt line that the last one was refused", async () => {
		const { lines, log } = linkLog();
		const { remote } = await refused(log);
		await failedRetry(remote, 1_000);
		await failedRetry(remote, 1_000);

		const deviceId = remote.deviceId;
		expect(lines.filter(line => line.message === "attempt").slice(-2)).toEqual([
			{ message: "attempt", details: { deviceId, n: 1, delayMs: 1_000, trigger: "backoff" } },
			{ message: "attempt", details: { deviceId, n: 2, delayMs: 1_000, trigger: "backoff", refused: true } },
		]);
	});

	it("dials a host that refuses every second while it restarts, and finds it within 2 s of its return", async () => {
		const { rig, remote } = await refused();
		for (let second = 0; second < 25; second++) await failedRetry(remote, 1_000);
		await startHost(rig.b, rig.port);

		await advanceCoreTimers(2_000);

		expect(remote.state).not.toBe("offline");
		await untilState(remote, "online");
	});

	it("backs off again once the refusals have lasted a minute", async () => {
		const { remote } = await refused();
		let dials = 0;
		remote.on("state", state => {
			if (state === "connecting") dials++;
		});
		for (let second = 0; second < 60; second++) await failedRetry(remote, 1_000);
		expect(dials).toBe(60);

		await failedRetry(remote, 1_000);
		expect(dials).toBe(61);
		await advanceCoreTimers(1_000);
		expect(dials).toBe(61);
		await failedRetry(remote, 1_000);
		expect(dials).toBe(62);
	});

	it("the host logs each connection's open and close with who, why and how long", async () => {
		const { lines, log } = linkLog();
		const settled = Promise.withResolvers<void>();
		let closes = 0;
		const rig = await startHost(await side(), 0, [LOOPBACK], (message, details) => {
			log(message, details);
			// The device's first contact (connectFirst) is a connection too, and ends on its own.
			if (message === "closed" && ++closes === 2) settled.resolve();
		});
		const { a, hosts, paired } = await connectedClient(rig);
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		remote.close();
		await settled.promise;

		expect(lines.map(line => line.message).sort()).toEqual(["closed", "closed", "open", "open"]);
		for (const { message, details } of lines) {
			const who = { deviceId: a.identity.deviceId, ms: expect.any(Number) };
			// The open line names the device's build and the slim frames it reads.
			expect(details).toEqual(
				message === "open"
					? {
							...who,
							appVersion: expect.any(String),
							slim: "events,progress,autopilot,ends,reads,tools,fields,status,lists,shift,settings,roster,jobs,outputs,args,deflate,context,sessions",
						}
					: { ...who, reason: "closed" },
			);
		}
	});
});

describe("the host's traffic line", () => {
	/** A connected client whose host writes its traffic line every `TRAFFIC_MS`, with what the host wrote to `remote-link`. */
	const TRAFFIC_MS = 300;
	async function connectedLink() {
		const { lines, log } = linkLog();
		const rig = await startHost(await side(), 0, [LOOPBACK], log, { trafficMs: TRAFFIC_MS });
		const { a, hosts, paired } = await connectedClient(rig);
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		lines.length = 0;
		return { lines, remote, deviceId: a.identity.deviceId };
	}

	it("says once a window what a busy link sent and received, by kind, with no payload", async () => {
		const { lines, remote, deviceId } = await connectedLink();
		const pad = "x".repeat(300_000);
		const pushed = Promise.withResolvers<unknown>();
		remote.on("event", (event, data) => {
			if (event === "pushed") pushed.resolve(data);
		});
		await remote.request("push", { pad });
		// The device said it reads deflated frames: the host's event crosses deflated and arrives whole.
		expect(await pushed.promise).toEqual({ pad });
		// The request and its event may fall in one window or two: what the lines say together is checked.
		const traffic = () =>
			lines
				.filter(line => line.message === "traffic")
				.map(
					line =>
						// As the runtime log keeps it (`remote-link` lines go through it): only primitive details survive.
						normalizeRuntimeErrorReport({ source: "remote-link", message: "traffic", details: line.details })
							.details as Record<string, unknown>,
				);
		const rows = () =>
			traffic().flatMap(
				details => JSON.parse(String(details.top)) as Array<{ kind: string; frames: number; bytes: number }>,
			);
		const bytesOf = (kind: string) => rows().reduce((sum, row) => sum + (row.kind === kind ? row.bytes : 0), 0);
		await vi.waitFor(() => expect(bytesOf("tx evt pushed")).toBeGreaterThan(0), { timeout: 5_000 });

		for (const details of traffic()) expect(details).toMatchObject({ deviceId, ms: expect.any(Number) });
		expect(bytesOf("rx req push")).toBeGreaterThan(300_000);
		expect(bytesOf("rx req push")).toBeLessThan(301_000);
		expect(bytesOf("tx evt pushed")).toBeLessThan(2_000);
		const sum = (key: "rx" | "tx") => traffic().reduce((total, details) => total + (details[key] as number), 0);
		expect(sum("rx")).toBeGreaterThanOrEqual(bytesOf("rx req push"));
		expect(sum("tx")).toBeGreaterThanOrEqual(bytesOf("tx evt pushed"));
		expect(JSON.stringify(traffic())).not.toContain("xxxx");
	});

	it("writes what a link sent before it closed inside the window", async () => {
		const { lines, log } = linkLog();
		const rig = await startHost(await side(), 0, [LOOPBACK], log);
		const { a, hosts, paired } = await connectedClient(rig);
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		await remote.request("push", { pad: "x".repeat(300_000) });
		remote.close();
		await vi.waitFor(() => expect(lines.filter(line => line.message === "closed")).toHaveLength(2));
		expect(lines.filter(line => line.message === "traffic")).toHaveLength(1);
	});
});

describe("protocol versions", () => {
	it("the host answers another handshake version (a code-pairing release's) with a protocol error", async () => {
		const rig = await startHost();
		const link = await dialLink(rig.port);
		const eph = generateKeyPair();
		const me = legacyIdentity();
		link.send({ t: "auth-init", v: 1, deviceId: me.deviceId, ephPub: eph.publicKey });
		expect(await link.receive(2_000)).toEqual({ t: "error", code: "protocol" });
		link.destroy();
	});

	it("the client reports a host hello with another protocol", async () => {
		const b = { identity: legacyIdentity() };
		const a = await side();
		// A host that completes the auth handshake but speaks protocol 2.
		const fake = await listenFake(socket => {
			const link = new LegacyLink(socket);
			void (async () => {
				const init = (await link.receive(2_000)) as unknown as { deviceId: string; ephPub: string };
				const eph = generateKeyPair();
				link.send({
					t: "auth-resp",
					deviceId: b.identity.deviceId,
					name: "Future",
					ephPub: eph.publicKey,
					staticPub: b.identity.publicKey,
				});
				const ikm = Buffer.concat([
					dh(eph.privateKey, init.ephPub),
					dh(eph.privateKey, a.identity.publicKey),
					dh(b.identity.privateKey, init.ephPub),
				]);
				const keys = authKeys(
					ikm,
					legacyTranscript(
						{ deviceId: init.deviceId, ephPub: init.ephPub, staticPub: a.identity.publicKey },
						{ deviceId: b.identity.deviceId, ephPub: eph.publicKey, staticPub: b.identity.publicKey },
					),
				);
				link.secure(keys.ba, keys.ab);
				await link.receive(2_000);
				link.send({ t: "hello", protocol: 2, appVersion: "9.0.0", name: "Future", ...MACHINE });
			})().catch(() => link.destroy());
		});
		const remote = client(a, {
			deviceId: b.identity.deviceId,
			name: "Future",
			staticPub: b.identity.publicKey,
			nodeId: "nFUTURE",
			addresses: [`${LOOPBACK}:${fake.port}`],
			pairedAt: Date.now(),
		});
		remote.connect();
		expect(await untilError(remote)).toBe("protocol");
	});

	it("the host rejects a client hello with another protocol", async () => {
		const rig = await startHost();
		const a = { identity: legacyIdentity() };
		const link = await dialLink(rig.port);
		const eph = generateKeyPair();
		link.send({
			t: "auth-init",
			v: 2,
			deviceId: a.identity.deviceId,
			name: "Laptop",
			ephPub: eph.publicKey,
			staticPub: a.identity.publicKey,
		});
		const resp = await link.receive(2_000);
		const hostEph = String(resp.ephPub);
		const ikm = Buffer.concat([
			dh(eph.privateKey, hostEph),
			dh(a.identity.privateKey, hostEph),
			dh(eph.privateKey, rig.b.identity.publicKey),
		]);
		const keys = authKeys(
			ikm,
			legacyTranscript(
				{ deviceId: a.identity.deviceId, ephPub: eph.publicKey, staticPub: a.identity.publicKey },
				{ deviceId: rig.b.identity.deviceId, ephPub: hostEph, staticPub: rig.b.identity.publicKey },
			),
		);
		link.secure(keys.ab, keys.ba);
		link.send({ t: "hello", protocol: 2, appVersion: "9.0.0", name: "Future" });
		expect(await link.receive(2_000)).toEqual({ t: "error", code: "protocol" });
		link.destroy();
		expect(rig.host.connections()).toEqual([]);
	});
});
