/**
 * Host ↔ client over real sockets on 127.0.0.1, with per-test temp userData directories. The host's Tailscale
 * check is the rig's `gate` (devices.ts asks `tailscale whois`; here a test says who connects).
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
import { normalizeRuntimeErrorReport } from "../runtime-log-core";
import { connectFirst, type LinkState, probeHost, RemoteClient, type RemoteClientOptions, RemoteError } from "./client";
import { authKeys, dh, generateKeyPair } from "./crypto";
import {
	type GateResult,
	type HostServices,
	RemoteHost,
	type RemoteHostOptions,
	type TailnetVisitor,
} from "./host-server";
import { HostStore, type PairedHost } from "./hosts-store";
import { type Identity, loadIdentity } from "./identity";
import { PeerStore } from "./peers-store";
import { AuthInit, authTranscriptOf, HANDSHAKE_VERSION } from "./protocol";
import { freePortRun } from "./test-ports";
import { Link, WAKE_CHECK_MS } from "./wire";

const APP_VERSION = "0.10.0";
const MACHINE = { platform: "darwin", ompVersion: "18.7.0", home: "/Users/b", sep: "/" };
const LOOPBACK = "127.0.0.1";

interface Side {
	dir: string;
	identity: Identity;
}

const dirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

function side(): Side {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-remote-"));
	dirs.push(dir);
	return { dir, identity: loadIdentity(dir) };
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

function visitor(nodeId = "nLAPTOP", login = "me@example.com"): GateResult {
	return { ok: true, visitor: { nodeId, login, nodeName: "laptop", ip: LOOPBACK } };
}

interface HostRig {
	b: Side;
	peers: PeerStore;
	host: RemoteHost;
	port: number;
	/** Who Tailscale says connects; tests change it. */
	gate: { next: (ip: string) => GateResult };
	/** Whether the person approves a new device, and who was asked about. */
	admit: { answer: boolean; asked: TailnetVisitor[] };
	addresses: { hosts: string[] };
}

async function startHost(
	b: Side = side(),
	port = 0,
	bindHosts = [LOOPBACK],
	logLink?: RemoteHostOptions["logLink"],
): Promise<HostRig> {
	const peers = new PeerStore(b.dir);
	const gate = { next: (_ip: string) => visitor() };
	const admit = { answer: true, asked: [] as TailnetVisitor[] };
	const addresses = { hosts: bindHosts };
	const host = new RemoteHost({
		identity: b.identity,
		peers,
		services,
		name: () => "Studio",
		port,
		bindHosts: async () => addresses.hosts,
		gate: async ip => gate.next(ip),
		admit: async seen => {
			admit.asked.push(seen);
			return admit.answer;
		},
		appVersion: APP_VERSION,
		hello: () => MACHINE,
		logLink,
	});
	await host.start();
	cleanups.push(() => host.stop());
	return { b, peers, host, port: host.port ?? 0, gate, admit, addresses };
}

async function connectedClient(
	rig: HostRig,
	a: Side = side(),
	nodeId = "nSTUDIO",
): Promise<{ a: Side; hosts: HostStore; paired: PairedHost }> {
	const hosts = new HostStore(a.dir);
	const paired = await connectFirst({
		identity: a.identity,
		address: `${LOOPBACK}:${rig.port}`,
		name: "Laptop",
		appVersion: APP_VERSION,
		nodeId,
		hosts,
	});
	return { a, hosts, paired };
}

function client(a: Side, paired: PairedHost, hosts?: HostStore, log?: RemoteClientOptions["log"]): RemoteClient {
	const remote = new RemoteClient({
		identity: a.identity,
		host: paired,
		appVersion: APP_VERSION,
		name: () => "Laptop",
		hosts,
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

/** Fake timers that leave `setImmediate` and the sockets alone: a link's real I/O still runs. */
function fakeLinkClock(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

/** Let the retry timer fire after `delayMs`, then wait for that attempt to fail. */
async function failedRetry(remote: RemoteClient, delayMs: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(delayMs);
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

function dialLink(port: number): Promise<Link> {
	const socket = connect({ host: LOOPBACK, port });
	const { promise, resolve, reject } = Promise.withResolvers<Link>();
	socket.once("error", reject);
	socket.once("connect", () => resolve(new Link(socket)));
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
	vi.useRealTimers();
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
		expect(new HostStore(a.dir).get(rig.b.identity.deviceId)).toEqual(paired);
		expect(new PeerStore(rig.b.dir).get(a.identity.deviceId)).toMatchObject({
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
		expect(rig.peers.list()).toEqual([]);
		expect(rig.admit.asked).toEqual([]);
	});

	it("asks about a new device only, and refuses it declined when the person says no", async () => {
		const rig = await startHost();
		rig.admit.answer = false;
		expect((await rejection(connectedClient(rig))).code).toBe("declined");
		expect(rig.peers.list()).toEqual([]);
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
		const pins = () => rig.peers.list().map(peer => [peer.deviceId, peer.nodeId, peer.staticPub]);
		const before = pins();
		// Same Tailscale node, a fresh OMPdesk identity (new device id and key): no new record, no new quota.
		expect((await rejection(connectedClient(rig))).code).toBe("key_mismatch");
		expect(pins()).toEqual(before);
		expect(before).toEqual([[a.identity.deviceId, "nLAPTOP", a.identity.publicKey]]);
		// The known device from another node is refused too.
		rig.gate.next = () => visitor("nOTHER");
		expect((await rejection(connectedClient(rig, a))).code).toBe("key_mismatch");
		// Removing the device frees the node.
		rig.gate.next = () => visitor();
		await rig.host.revoke(a.identity.deviceId);
		await connectedClient(rig);
		expect(rig.peers.list()).toHaveLength(1);
	});

	it("refuses a known device id that comes with another key", async () => {
		const rig = await startHost();
		const { a } = await connectedClient(rig);
		rig.peers.update(a.identity.deviceId, { staticPub: generateKeyPair().publicKey });
		expect((await rejection(connectedClient(rig, a))).code).toBe("key_mismatch");
	});

	it("binds a device paired by code to the node it first connects from, keeping its limits", async () => {
		const rig = await startHost();
		const a = side();
		rig.peers.put({
			deviceId: a.identity.deviceId,
			name: "Laptop",
			staticPub: a.identity.publicKey,
			nodeId: null,
			login: null,
			pairedAt: 1,
			limits: { requestsPerDay: 5 },
		});
		await connectedClient(rig, a);
		expect(rig.peers.get(a.identity.deviceId)).toMatchObject({
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
		const hosts = new HostStore(a.dir);
		hosts.update(paired.deviceId, { staticPub: generateKeyPair().publicKey });
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

	it("takes the next port of its list when the first is busy, and says so when all are", async () => {
		const one = await heldRun(5);
		for (const index of [1, 2, 3, 4]) await one.release(index);
		const base = one.base;
		const next = await startHost(side(), base);
		expect(next.host.port).toBe(base + 1);
		await next.host.stop();

		const held = await heldRun(5);
		const all = held.base;
		const rig = await startHost(side(), all);
		expect(rig.host.port).toBeNull();
		expect(rig.host.listenError).toEqual({ code: "port_in_use", ports: [all, all + 1, all + 2, all + 3, all + 4] });
		// A port coming free is taken on the next rebind (devices.ts runs one every 15 s).
		await held.release(0);
		await rig.host.rebind();
		expect(rig.host.port).toBe(all);
		expect(rig.host.listenError).toBeNull();
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
		expect(rig.peers.get(a.identity.deviceId)).toBeUndefined();
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
		hosts.update(paired.deviceId, { addresses: [`${LOOPBACK}:${dead}`, working] });
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		expect(new HostStore(a.dir).get(paired.deviceId)?.addresses).toEqual([working, `${LOOPBACK}:${dead}`]);
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
		fakeLinkClock();
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
		});
	});

	it("a wake that finds the host still down starts the backoff over at 1 s", async () => {
		const { lines, log } = linkLog();
		const { remote, paired } = await backedOff(log);

		remote.wake("online");
		await untilState(remote, "offline");
		await failedRetry(remote, 1_000);

		expect(lines.filter(line => line.message === "attempt").slice(-2)).toEqual([
			{ message: "attempt", details: { deviceId: paired.deviceId, n: 5, delayMs: 0, trigger: "online" } },
			{ message: "attempt", details: { deviceId: paired.deviceId, n: 6, delayMs: 1_000, trigger: "backoff" } },
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
		fakeLinkClock();
		const { lines, log } = linkLog();
		const remote = client(a, { ...paired, addresses: [`${LOOPBACK}:${relay.port}`] }, undefined, log);
		remote.connect();
		await untilState(remote, "online");
		await vi.advanceTimersByTimeAsync(5_000);
		silence.on = true;

		remote.wake("focus");
		await vi.advanceTimersByTimeAsync(WAKE_CHECK_MS);

		expect(remote.state).not.toBe("online");
		expect(lines.find(line => line.message === "down")?.details).toEqual({
			deviceId: paired.deviceId,
			name: "Studio",
			reason: "dead",
			wasOnlineMs: 5_000 + WAKE_CHECK_MS,
		});
	});

	it("logs an outage: down with the reason, each attempt, up with how long it lasted", async () => {
		const rig = await startHost();
		const { a, hosts, paired } = await connectedClient(rig);
		fakeLinkClock();
		const { lines, log } = linkLog();
		const remote = client(a, paired, hosts, log);
		remote.connect();
		await untilState(remote, "online");
		await vi.advanceTimersByTimeAsync(2_000);
		await rig.host.stop();
		const dropping = await listenFake(socket => socket.destroy(), rig.port);
		await untilState(remote, "offline");
		await failedRetry(remote, 1_000);
		await failedRetry(remote, 2_000);
		await hostBack(rig, dropping.server);
		await vi.advanceTimersByTimeAsync(4_000);
		await untilState(remote, "online");

		const id = paired.deviceId;
		expect(lines).toEqual([
			{ message: "attempt", details: { deviceId: id, n: 1, delayMs: 0, trigger: "start" } },
			// Each "up" names the build the host runs, as the host's own "open" line names the device's.
			{ message: "up", details: { deviceId: id, outageMs: 0, attempts: 1, appVersion: APP_VERSION } },
			{ message: "down", details: { deviceId: id, name: "Studio", reason: "closed", wasOnlineMs: 2_000 } },
			{ message: "attempt", details: { deviceId: id, n: 1, delayMs: 1_000, trigger: "backoff" } },
			{ message: "attempt", details: { deviceId: id, n: 2, delayMs: 2_000, trigger: "backoff" } },
			{ message: "attempt", details: { deviceId: id, n: 3, delayMs: 4_000, trigger: "backoff" } },
			{ message: "up", details: { deviceId: id, outageMs: 7_000, attempts: 3, appVersion: APP_VERSION } },
		]);
	});

	/** The host's app quit (an update, a restart): its computer answers every dial with a refusal. */
	async function refused() {
		const rig = await startHost();
		const { a, hosts, paired } = await connectedClient(rig);
		fakeLinkClock();
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		await rig.host.stop();
		await untilState(remote, "offline");
		return { rig, remote };
	}

	it("dials a host that refuses every second while it restarts, and finds it within 2 s of its return", async () => {
		const { rig, remote } = await refused();
		for (let second = 0; second < 25; second++) await failedRetry(remote, 1_000);
		await startHost(rig.b, rig.port);

		await vi.advanceTimersByTimeAsync(2_000);

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
		await vi.advanceTimersByTimeAsync(1_000);
		expect(dials).toBe(61);
		await failedRetry(remote, 1_000);
		expect(dials).toBe(62);
	});

	it("the host logs each connection's open and close with who, why and how long", async () => {
		const { lines, log } = linkLog();
		const settled = Promise.withResolvers<void>();
		let closes = 0;
		const rig = await startHost(side(), 0, [LOOPBACK], (message, details) => {
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
					? { ...who, appVersion: expect.any(String), slim: "events,progress,autopilot,ends,reads" }
					: { ...who, reason: "closed" },
			);
		}
	});
});

describe("the host's traffic line", () => {
	/** Fake time on the host's side of a connected client, with what the host wrote to `remote-link`. */
	async function connectedLink() {
		const { lines, log } = linkLog();
		const rig = await startHost(side(), 0, [LOOPBACK], log);
		const { a, hosts, paired } = await connectedClient(rig);
		fakeLinkClock();
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		lines.length = 0;
		return { lines, remote, deviceId: a.identity.deviceId };
	}

	/** The fake clock, a second at a time so pings and pongs on the real sockets keep the link alive. */
	async function minutePasses(seconds = 60): Promise<void> {
		for (let second = 0; second < seconds; second++) await vi.advanceTimersByTimeAsync(1_000);
	}

	it("says once a minute what a busy link sent and received, by kind, with no payload", async () => {
		const { lines, remote, deviceId } = await connectedLink();
		const pad = "x".repeat(300_000);
		await remote.request("push", { pad });
		await minutePasses();

		const traffic = lines.filter(line => line.message === "traffic");
		expect(traffic).toHaveLength(1);
		// As the runtime log keeps it (`remote-link` lines go through it): only primitive details survive.
		const details = normalizeRuntimeErrorReport({
			source: "remote-link",
			message: "traffic",
			details: (traffic[0] as LinkLine).details,
		}).details as Record<string, unknown>;
		expect(details).toMatchObject({ deviceId, ms: expect.any(Number) });
		const top = JSON.parse(String(details.top)) as Array<{ kind: string; frames: number; bytes: number }>;
		expect(top.map(row => row.kind)).toEqual(expect.arrayContaining(["rx req push", "tx evt pushed"]));
		const bytesOf = (kind: string) => top.find(row => row.kind === kind)?.bytes ?? 0;
		expect(bytesOf("rx req push")).toBeGreaterThan(300_000);
		expect(bytesOf("rx req push")).toBeLessThan(301_000);
		expect(bytesOf("tx evt pushed")).toBeGreaterThan(300_000);
		expect(bytesOf("tx evt pushed")).toBeLessThan(301_000);
		expect(details.rx as number).toBeGreaterThanOrEqual(bytesOf("rx req push"));
		expect(details.tx as number).toBeGreaterThanOrEqual(bytesOf("tx evt pushed"));
		expect(JSON.stringify(details)).not.toContain("xxxx");
	});

	it("writes nothing for a link that only pinged", async () => {
		const { lines } = await connectedLink();
		await minutePasses(130);
		expect(lines.filter(line => line.message === "traffic")).toEqual([]);
	});

	it("writes what a link sent before it closed inside the minute", async () => {
		const { lines, remote } = await connectedLink();
		await remote.request("push", { pad: "x".repeat(300_000) });
		remote.close();
		await vi.waitFor(() => expect(lines.some(line => line.message === "closed")).toBe(true));
		expect(lines.filter(line => line.message === "traffic")).toHaveLength(1);
	});
});

describe("protocol versions", () => {
	it("the host answers another handshake version (a code-pairing release's) with a protocol error", async () => {
		const rig = await startHost();
		const link = await dialLink(rig.port);
		const eph = generateKeyPair();
		const me = side().identity;
		link.send({ t: "auth-init", v: 1, deviceId: me.deviceId, ephPub: eph.publicKey });
		expect(await link.receive(2_000)).toEqual({ t: "error", code: "protocol" });
		link.destroy();
	});

	it("the client reports a host hello with another protocol", async () => {
		const b = side();
		const a = side();
		// A host that completes the auth handshake but speaks protocol 2.
		const fake = await listenFake(socket => {
			const link = new Link(socket);
			void (async () => {
				const init = AuthInit.parse(await link.receive(2_000));
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
					authTranscriptOf(
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
		const { a } = await connectedClient(rig);
		const link = await dialLink(rig.port);
		const eph = generateKeyPair();
		link.send({
			t: "auth-init",
			v: HANDSHAKE_VERSION,
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
			authTranscriptOf(
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
