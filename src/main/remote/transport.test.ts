/**
 * Host ↔ client over real sockets on 127.0.0.1, with per-test temp userData
 * directories. The host's clock is injectable for code expiry.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import { type LinkState, pairWithHost, RemoteClient, RemoteError } from "./client";
import { authKeys, dh, generateKeyPair } from "./crypto";
import { CODE_TTL_MS, type HostServices, MAX_CODE_FAILURES, RemoteHost } from "./host-server";
import { HostStore, type PairedHost } from "./hosts-store";
import { type Identity, loadIdentity } from "./identity";
import { PeerStore } from "./peers-store";
import { AuthInit, authTranscriptOf } from "./protocol";
import { Link } from "./wire";

const APP_VERSION = "0.10.0";
const MACHINE = { platform: "darwin", ompVersion: "18.7.0", home: "/Users/b", sep: "/" };
// Beacons from these hosts go to an otherwise unused port.
const TEST_DISCOVERY_PORT = 47_899;

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

interface HostRig {
	b: Side;
	peers: PeerStore;
	host: RemoteHost;
	port: number;
	clock: { now: number };
}

async function startHost(b: Side = side(), port = 0, clock = { now: Date.now() }): Promise<HostRig> {
	const peers = new PeerStore(b.dir);
	const host = new RemoteHost({
		identity: b.identity,
		peers,
		services,
		name: () => "Studio",
		port,
		discoveryPort: TEST_DISCOVERY_PORT,
		appVersion: APP_VERSION,
		hello: () => MACHINE,
		now: () => clock.now,
	});
	const started = await host.start();
	cleanups.push(() => host.stop());
	return { b, peers, host, port: started.port, clock };
}

async function pairedClient(
	rig: HostRig,
	a: Side = side(),
): Promise<{ a: Side; hosts: HostStore; paired: PairedHost }> {
	const hosts = new HostStore(a.dir);
	const paired = await pairWithHost({
		identity: a.identity,
		address: `127.0.0.1:${rig.port}`,
		code: rig.host.pairingCode().code,
		name: "Laptop",
		appVersion: APP_VERSION,
		hosts,
	});
	return { a, hosts, paired };
}

function client(a: Side, paired: PairedHost, hosts?: HostStore): RemoteClient {
	const remote = new RemoteClient({
		identity: a.identity,
		host: paired,
		appVersion: APP_VERSION,
		name: () => "Laptop",
		hosts,
	});
	cleanups.push(() => remote.close());
	return remote;
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

function wrongCode(code: string): string {
	return code.replace(/^./, first => (first === "2" ? "3" : "2"));
}

function dialLink(port: number): Promise<Link> {
	const socket = connect({ host: "127.0.0.1", port });
	const { promise, resolve, reject } = Promise.withResolvers<Link>();
	socket.once("error", reject);
	socket.once("connect", () => resolve(new Link(socket)));
	return promise;
}

function listenFake(onSocket: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
	const server = createServer(onSocket);
	const { promise, resolve } = Promise.withResolvers<{ server: Server; port: number }>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
	});
	cleanups.push(() => {
		server.close();
	});
	return promise;
}

beforeEach(() => {
	dirs.length = 0;
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("pairing", () => {
	it("persists both sides and consumes the code", async () => {
		const rig = await startHost();
		const before = rig.host.pairingCode().code;
		const { a, paired } = await pairedClient(rig);

		expect(paired).toMatchObject({
			deviceId: rig.b.identity.deviceId,
			name: "Studio",
			staticPub: rig.b.identity.publicKey,
			addresses: [`127.0.0.1:${rig.port}`],
		});
		expect(new HostStore(a.dir).get(rig.b.identity.deviceId)).toEqual(paired);
		expect(new PeerStore(rig.b.dir).get(a.identity.deviceId)).toMatchObject({
			deviceId: a.identity.deviceId,
			name: "Laptop",
			staticPub: a.identity.publicKey,
		});
		expect(rig.host.pairingCode().code).not.toBe(before);
	});

	it("accepts the code typed loosely", async () => {
		const rig = await startHost();
		const typed = rig.host
			.pairingCode()
			.code.toLowerCase()
			.replace("-", " ")
			.replaceAll("1", "l")
			.replaceAll("0", "o");
		const a = side();
		const paired = await pairWithHost({
			identity: a.identity,
			address: `127.0.0.1:${rig.port}`,
			code: typed,
			name: "Laptop",
			appVersion: APP_VERSION,
		});
		expect(paired.deviceId).toBe(rig.b.identity.deviceId);
	});

	it("answers wrong_code, and rotates the code with locked on the 5th failure", async () => {
		const rig = await startHost();
		const { code } = rig.host.pairingCode();
		const attempt = () =>
			pairWithHost({
				identity: side().identity,
				address: `127.0.0.1:${rig.port}`,
				code: wrongCode(code),
				name: "Mallory",
				appVersion: APP_VERSION,
			});
		for (let i = 1; i < MAX_CODE_FAILURES; i++) expect((await rejection(attempt())).code).toBe("wrong_code");
		expect(rig.host.pairingCode().code).toBe(code);
		expect((await rejection(attempt())).code).toBe("locked");
		expect(rig.host.pairingCode().code).not.toBe(code);
		expect(rig.peers.list()).toEqual([]);
	});

	it("fails an expired code", async () => {
		const rig = await startHost();
		const { code } = rig.host.pairingCode();
		rig.clock.now += CODE_TTL_MS + 1;
		const error = await rejection(
			pairWithHost({
				identity: side().identity,
				address: `127.0.0.1:${rig.port}`,
				code,
				name: "Late",
				appVersion: APP_VERSION,
			}),
		);
		expect(error.code).toBe("expired");
		expect(rig.peers.list()).toEqual([]);
	});

	it("does not accept a used code twice", async () => {
		const rig = await startHost();
		const { code } = rig.host.pairingCode();
		const first = side();
		await pairWithHost({
			identity: first.identity,
			address: `127.0.0.1:${rig.port}`,
			code,
			name: "One",
			appVersion: APP_VERSION,
		});
		const error = await rejection(
			pairWithHost({
				identity: side().identity,
				address: `127.0.0.1:${rig.port}`,
				code,
				name: "Two",
				appVersion: APP_VERSION,
			}),
		);
		expect(error.code).toBe("wrong_code");
		expect(rig.peers.list().map(peer => peer.deviceId)).toEqual([first.identity.deviceId]);
	});

	it("reports an unreachable host", async () => {
		const { server, port } = await listenFake(socket => socket.destroy());
		server.close();
		const error = await rejection(
			pairWithHost({
				identity: side().identity,
				address: `127.0.0.1:${port}`,
				code: "ABCD-EFGH",
				name: "A",
				appVersion: APP_VERSION,
			}),
		);
		expect(error.code).toBe("unreachable");
	});

	it("falls back to an ephemeral port when the configured one is busy", async () => {
		const first = await startHost();
		const second = await startHost(side(), first.port);
		expect(second.port).not.toBe(first.port);
		expect(second.host.port).toBe(second.port);
	});
});

describe("authenticated link", () => {
	it("round-trips requests and pushes events", async () => {
		const rig = await startHost();
		const { a, hosts, paired } = await pairedClient(rig);
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
		const { a, paired } = await pairedClient(rig);
		const remote = client(a, paired);
		expect((await rejection(remote.request("echo", 1))).code).toBe("remote_offline");

		remote.connect();
		await untilState(remote, "online");
		await rig.host.stop();
		await untilState(remote, "offline");
		expect((await rejection(remote.request("echo", 1))).code).toBe("remote_offline");
	});

	it("refuses an unpaired device", async () => {
		const rig = await startHost();
		const stranger = side();
		const remote = client(stranger, {
			deviceId: rig.b.identity.deviceId,
			name: "Studio",
			staticPub: rig.b.identity.publicKey,
			addresses: [`127.0.0.1:${rig.port}`],
			pairedAt: Date.now(),
		});
		remote.connect();
		expect(await untilError(remote)).toBe("unpaired");
		expect(rig.host.connections()).toEqual([]);
	});

	it("revoke drops the live link and refuses the device afterwards", async () => {
		const rig = await startHost();
		const { a, paired } = await pairedClient(rig);
		const remote = client(a, paired);
		remote.connect();
		await untilState(remote, "online");

		await rig.host.revoke(a.identity.deviceId);
		expect(rig.host.connections()).toEqual([]);
		expect(rig.peers.get(a.identity.deviceId)).toBeUndefined();
		expect(await untilError(remote)).toBe("unpaired");
	});

	it("closes the connection on a tampered ciphertext frame", async () => {
		const rig = await startHost();
		const { a, paired } = await pairedClient(rig);
		// A relay that flips the last byte (the GCM tag) of the next client chunk once armed.
		let armed = false;
		const relay = await listenFake(inbound => {
			const outbound = connect({ host: "127.0.0.1", port: rig.port });
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
		const remote = client(a, { ...paired, addresses: [`127.0.0.1:${relay.port}`] });
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
		const { a, hosts, paired } = await pairedClient(rig);
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

	it("tries each stored address and keeps the working one first", async () => {
		const rig = await startHost();
		const { a, hosts, paired } = await pairedClient(rig);
		const { server, port: dead } = await listenFake(socket => socket.destroy());
		server.close();
		const working = `127.0.0.1:${rig.port}`;
		hosts.update(paired.deviceId, { addresses: [`127.0.0.1:${dead}`, working] });
		const remote = client(a, paired, hosts);
		remote.connect();
		await untilState(remote, "online");
		expect(new HostStore(a.dir).get(paired.deviceId)?.addresses).toEqual([working, `127.0.0.1:${dead}`]);
	});
});

describe("protocol versions", () => {
	it("the host answers a newer handshake version with a protocol error", async () => {
		const rig = await startHost();
		const link = await dialLink(rig.port);
		const eph = generateKeyPair();
		const me = side().identity;
		link.send({
			t: "pair-init",
			v: 2,
			deviceId: me.deviceId,
			name: "Future",
			ephPub: eph.publicKey,
			staticPub: me.publicKey,
		});
		expect(await link.receive(2_000)).toEqual({ t: "error", code: "protocol" });
		link.destroy();
	});

	it("pairing reports a host that rejects our version", async () => {
		const fake = await listenFake(socket => {
			const link = new Link(socket);
			void link.receive(2_000).then(() => {
				link.send({ t: "error", code: "protocol" });
				link.close();
			});
		});
		const error = await rejection(
			pairWithHost({
				identity: side().identity,
				address: `127.0.0.1:${fake.port}`,
				code: "ABCD-EFGH",
				name: "A",
				appVersion: APP_VERSION,
			}),
		);
		expect(error.code).toBe("protocol");
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
				link.send({ t: "auth-resp", deviceId: b.identity.deviceId, ephPub: eph.publicKey });
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
			addresses: [`127.0.0.1:${fake.port}`],
			pairedAt: Date.now(),
		});
		remote.connect();
		expect(await untilError(remote)).toBe("protocol");
	});

	it("the host rejects a client hello with another protocol", async () => {
		const rig = await startHost();
		const { a } = await pairedClient(rig);
		const link = await dialLink(rig.port);
		const eph = generateKeyPair();
		link.send({ t: "auth-init", v: 1, deviceId: a.identity.deviceId, ephPub: eph.publicKey });
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
