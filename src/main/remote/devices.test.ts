/**
 * Sharing a computer over Tailscale, end to end in one process: a host B and a device A (RemoteDevices each, real
 * sockets on 127.0.0.1, a fake Tailscale per computer; test-devices.ts).
 */
import * as fs from "node:fs/promises";
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codedError, ipcErrorCode } from "../../shared/ipc-error-codes";
import { IPC_EVENTS } from "../../shared/ipc-types";
import type { SessionSummary } from "../../shared/session-summary";
import { stopCore } from "../core/process";
import { advanceCoreTimers, fakeCoreTimers, realCoreTimers } from "../core/test-clock";
import {
	MOBILE_WEB_LINK_EVENT,
	MODELS_CHANGED_EVENT,
	PREVIEW_RELAY_EVENT,
	SESSIONS_DELETED_EVENT,
	SessionsDeletedParams,
	SUMMARIES_EVENT,
	TAB_EVENT,
} from "./app-protocol";
import { probeHost } from "./client";
import type { HostConnection } from "./host-server";
import { loadIdentity } from "./identity";
import { type Computer, DevicesRig, fakeTailnet, LOGIN, LOOPBACK, studioNode, until } from "./test-devices";
import { generateKeyPair } from "./test-legacy-peer";
import { hostStore, peerStore } from "./test-stores";
import { WAKE_CHECK_MS } from "./wire";

const rig = new DevicesRig();
const servers: Server[] = [];
const held: Socket[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await realCoreTimers();
	await rig.dispose();
	for (const server of servers.splice(0)) server.close();
	for (const socket of held.splice(0)) socket.destroy();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return ipcErrorCode(error);
	}
	throw new Error("expected a rejection");
}

function hold(port: number): Promise<void> {
	const server = createServer(socket => socket.destroy());
	servers.push(server);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(port, LOOPBACK, () => resolve());
	return promise;
}

function summary(sessionPath: string, status: SessionSummary["status"] = "running"): SessionSummary {
	return { sessionPath, tabId: "t1", cwd: "/s", kind: "agent", status, agents: [] };
}

/** What this computer's windows heard of session summaries, in order. */
function summariesPushed(computer: Computer): unknown[] {
	return computer.broadcasts
		.filter(entry => entry.channel === IPC_EVENTS.SESSION_SUMMARIES_CHANGED)
		.map(entry => entry.data);
}

/** Waits until the link handled every event emitted before: a change on a version nobody holds ends in one more read of the set. */
async function eventsHandled(a: Computer, b: Computer, conn: HostConnection): Promise<void> {
	const before = summariesPushed(a).length;
	b.services.call.mockImplementation(async (_peer, method) =>
		method === "sessions.summaries" ? { version: "marker.1", sessions: [] } : null,
	);
	conn.emit(SUMMARIES_EVENT, { base: "missed", version: "marker.2", set: [], remove: [] });
	await vi.waitFor(() => expect(summariesPushed(a).length).toBeGreaterThan(before));
}

describe("computers of the tailnet", () => {
	it("lists the host, connects to it without a code, and marks it connected", async () => {
		const { a, b } = await rig.pair();
		const [listed] = await a.devices.watchTailnet(1, true);
		expect(listed).toEqual({
			nodeId: "nSTUDIO",
			name: "Studio",
			login: LOGIN,
			state: "available",
			refusal: null,
			deviceId: expect.any(String),
			connected: false,
		});
		const view = await a.devices.connect("nSTUDIO");
		await until(a, state => state.hosts[0]?.state === "online");
		const peers = (await until(b, state => state.host.peers[0]?.online === true)).host.peers;
		// Each side names the OMPdesk version the other runs, from its hello.
		expect(peers).toMatchObject([{ name: "Laptop", login: LOGIN, appVersion: "1.0.0" }]);
		expect(a.devices.state().hosts[0]?.appVersion).toBe("1.0.0");
		expect(a.devices.state().appVersion).toBe("1.0.0");
		expect(view.name).toBe("Studio");
		expect(a.tailnet.pushed).toMatchObject([{ nodeId: "nSTUDIO", connected: true }]);

		// Offline, the host's last hello no longer says what it runs: it may update before it comes back.
		await b.devices.setHostEnabled(false);
		const offline = await until(a, state => state.hosts[0]?.state !== "online");
		expect(offline.hosts[0]?.appVersion).toBeUndefined();
	});

	it("never probes a phone, an offline node, or this computer itself", async () => {
		const { a } = await rig.pair();
		a.fake.peers.push(studioNode({ nodeId: "nPHONE", os: "iOS" }), studioNode({ nodeId: "nOFF", online: false }));
		const listed = await a.devices.watchTailnet(1, true);
		expect(listed.map(computer => computer.nodeId)).toEqual(["nSTUDIO"]);
	});

	it("shows a host that refuses this device's login, and refuses the connection with the reason", async () => {
		const { a, b } = await rig.pair();
		b.allowed.splice(0, 1, "someone-else@example.com");
		const [listed] = await a.devices.watchTailnet(1, true);
		expect(listed).toMatchObject({ state: "refused", refusal: "not_allowed", deviceId: null });
		expect(await rejectionCode(a.devices.connect("nSTUDIO"))).toBe("remote_not_allowed");
		expect(b.devices.state().host.peers).toEqual([]);
	});

	it("asks the host's person about a new device when the one approval switch (Mobile web's) is on, and refuses a declined one", async () => {
		const { a, b } = await rig.pair();
		b.prefs.set("mobileWeb.confirmNewDevices", true);
		b.confirm.answer = false;
		expect(await rejectionCode(a.devices.connect("nSTUDIO"))).toBe("remote_declined");
		expect(b.confirm.asked).toEqual(["Laptop"]);
		expect(b.devices.state().host.peers).toEqual([]);
	});
});

describe("connecting again to a host already paired", () => {
	it("moves the host's open tabs onto the new link: re-attached, commands and the host's events reach them, and they leave it on dispose", async () => {
		const { a, b, hostId } = await rig.connected();
		const conns: HostConnection[] = [];
		const methods: string[] = [];
		b.services.call.mockImplementation(async (_peer, method, _params, conn) => {
			methods.push(method as string);
			if (method === "tab.open") {
				conns.push(conn as HostConnection);
				return { cwd: "/work", kind: "agent", attached: conns.length > 1 };
			}
			if (method === "tab.command")
				return { type: "response", command: "get_state", success: true, data: { ok: conns.length } };
			return {};
		});
		const ready = (conn: HostConnection) =>
			conn.emit(TAB_EVENT, {
				rtab: "t1",
				name: "status",
				arg: { status: "ready", statusPayload: {}, processAlive: true, cwd: "/work", kind: "agent", omp: "omp-1" },
			});
		const tab = a.devices.createSidecar(hostId, "t1", "/work", "agent", true);
		const statuses: string[] = [];
		tab.on("status", ({ status }: { status: string }) => statuses.push(status));
		tab.start();
		await vi.waitFor(() => expect(methods).toContain("tab.start"));
		ready(conns[0] as HostConnection);
		await vi.waitFor(() => expect(tab.status).toBe("ready"));

		await a.devices.connect("nSTUDIO");
		// The tab re-attaches over the new link: a second `tab.open`, on the new connection.
		await vi.waitFor(() => expect(conns).toHaveLength(2));
		expect(conns[1]).not.toBe(conns[0]);
		expect(tab.offline).toBe(false);
		ready(conns[1] as HostConnection);
		await vi.waitFor(() => expect(tab.status).toBe("ready"));
		expect(statuses).not.toContain("error");
		await expect(tab.rpcClient?.command({ type: "get_state" })).resolves.toMatchObject({ data: { ok: 2 } });

		// Its close goes over the new link too.
		tab.dispose();
		await vi.waitFor(() =>
			expect(b.services.call.mock.calls.find(call => call[1] === "tab.close")?.[3]).toBe(conns[1]),
		);
	});
});

describe("blocking", () => {
	it("blocks the device's node: it drops, is refused, and connects again once unblocked", async () => {
		const { a, b } = await rig.connected();
		const peerId = b.devices.state().host.peers[0]?.deviceId ?? "";
		await b.devices.blockPeer(peerId);
		expect(b.blocks.list()).toMatchObject([{ id: "node:nLAPTOP", scope: "node", tailscaleLogin: LOGIN }]);
		expect(b.devices.state().host.peers).toEqual([]);
		await until(a, state => state.hosts[0]?.state !== "online");
		expect((await a.devices.watchTailnet(1, true))[0]).toMatchObject({ state: "refused", refusal: "blocked" });

		b.blocks.remove("node:nLAPTOP");
		await a.devices.connect("nSTUDIO");
		await until(a, state => state.hosts[0]?.state === "online");
		await until(b, state => state.host.peers[0]?.online === true);
	});
});

describe("ports", () => {
	it("finds a host that took the next port when the first was busy", async () => {
		const port = await rig.pickPort();
		await hold(port);
		const b = await rig.computer(
			"Studio",
			fakeTailnet({ whois: new Map([[LOOPBACK, { nodeId: "nLAPTOP", nodeName: "laptop", login: LOGIN }]]) }),
		);
		await b.devices.setHostEnabled(true);
		// A successor of its list (another process may hold the next one too).
		expect(b.devices.state().host.port).toBeGreaterThan(port);
		const a = await rig.computer("Laptop", fakeTailnet({ peers: [studioNode()] }));
		expect((await a.devices.watchTailnet(1, true))[0]?.state).toBe("available");
		await a.devices.connect("nSTUDIO");
		await until(a, state => state.hosts[0]?.state === "online");
	});

	it("says which ports are taken instead of listening somewhere a device would not look", async () => {
		const port = await rig.pickPort();
		const held = [port, port + 1, port + 2, port + 3, port + 4];
		try {
			for (const busy of held) await hold(busy);
		} catch {
			return; // Another process holds one of them: nothing to check on this run.
		}
		const b = await rig.computer("Studio", fakeTailnet());
		const state = await b.devices.setHostEnabled(true);
		expect(state.host.port).toBeNull();
		expect(state.host.listenError).toEqual({ code: "port_in_use", ports: held });
	});
});

describe("two computers that use each other as hosts", () => {
	/**
	 * Both apps restart together (an update on each): every link drops, then both listen again and each dials the
	 * other. `gateMs` makes each host's gate (its `whois`) that slow, as on a loaded runner.
	 */
	async function reconnectBothWays(gateMs = 0) {
		await rig.pickPort();
		const lines: { message: string; details: Record<string, unknown>; at: number }[] = [];
		const logLink = (message: string, details: Record<string, unknown>) =>
			lines.push({ message, details, at: Date.now() });
		const studioTailnet = fakeTailnet({
			peers: [studioNode({ nodeId: "nLAPTOP", name: "laptop" })],
			whois: new Map([[LOOPBACK, { nodeId: "nLAPTOP", nodeName: "laptop", login: LOGIN }]]),
		});
		const laptopTailnet = fakeTailnet({
			peers: [studioNode()],
			whois: new Map([[LOOPBACK, { nodeId: "nSTUDIO", nodeName: "studio", login: LOGIN }]]),
		});
		const b = await rig.computer("Studio", studioTailnet, { logLink });
		const a = await rig.computer("Laptop", laptopTailnet, { logLink });
		for (const c of [a, b]) {
			c.devices.start();
			await c.devices.setHostEnabled(true);
			await until(c, state => state.host.port !== null);
		}
		await a.devices.connect("nSTUDIO");
		await b.devices.connect("nLAPTOP");
		await until(a, state => state.hosts[0]?.state === "online");
		await until(b, state => state.hosts[0]?.state === "online");

		await Promise.all([a.devices.setHostEnabled(false), b.devices.setHostEnabled(false)]);
		await until(a, state => state.hosts[0]?.state !== "online");
		await until(b, state => state.hosts[0]?.state !== "online");
		studioTailnet.whoisDelayMs = laptopTailnet.whoisDelayMs = gateMs;
		const reopened = lines.length;
		await Promise.all([a.devices.setHostEnabled(true), b.devices.setHostEnabled(true)]);
		await until(a, state => state.hosts[0]?.state === "online", 10_000);
		await until(b, state => state.hosts[0]?.state === "online", 10_000);
		const settled = lines.length;
		await new Promise(resolve => setTimeout(resolve, 3_000));

		expect(a.devices.state().hosts[0]?.state).toBe("online");
		expect(b.devices.state().hosts[0]?.state).toBe("online");
		expect(lines.slice(settled).filter(line => line.message === "down" || line.message === "attempt")).toEqual([]);
		const attempts = lines.slice(reopened).filter(line => line.message === "attempt");
		// Neither dial ended by the other's link opening while younger than the stale step (1 s): the other's link
		// reaching this computer's host (`peer`) may end only a dial that has waited that long, and the dial then runs
		// again at once. How many attempts a host logs after the restart is a race: none when a dial begun while the
		// hosts went down was taken by the closing listener and finished, one when its backoff or the other's link
		// woke it, two when a slow gate held it past the stale step.
		for (const host of [a, b]) {
			const id = host.devices.state().hosts[0]?.deviceId;
			// Every attempt line for the host, so a rerun after the restart is timed against its dial even when that
			// dial began before it.
			const history = lines.filter(line => line.message === "attempt" && line.details.deviceId === id);
			const first = history.length - attempts.filter(line => line.details.deviceId === id).length;
			for (const [index, attempt] of history.entries()) {
				if (index < first) continue;
				expect(["backoff", "peer"]).toContain(attempt.details.trigger);
				if (attempt.details.trigger !== "peer" || index === 0) continue;
				// The stale step is the core's 1 s; the lines cross to main after it, so allow a little of their delay.
				expect(attempt.at - (history[index - 1]?.at ?? 0), JSON.stringify(history)).toBeGreaterThanOrEqual(900);
			}
		}
		return attempts;
	}

	it("reconnect to each other at once and stay connected (each one's link opening never ends the other's dial)", async () => {
		await reconnectBothWays();
	}, 20_000);

	it("a host whose gate takes longer than the stale step still ends connected both ways, any rerun a `peer` one", async () => {
		// The slow gate holds each handshake past the stale step. Whether the other's link opens in that time (and a
		// dial runs again) is a race of the two computers' backoffs; either way the rule above holds.
		await reconnectBothWays(1_200);
	}, 30_000);
});

describe("two apps on one address that took each other's ports", () => {
	it("dial the host on its new port: this computer's own host on the old one is not the host's answer", async () => {
		// Two apps on the rig's loopback restart in the other order and each takes the port the other had. Each one's
		// first dial then reaches its own host, which holds the other's node pinned and refuses it `key_mismatch`.
		await rig.pickPort();
		const b = await rig.computer(
			"Studio",
			fakeTailnet({
				peers: [studioNode({ nodeId: "nLAPTOP", name: "laptop" })],
				whois: new Map([[LOOPBACK, { nodeId: "nLAPTOP", nodeName: "laptop", login: LOGIN }]]),
			}),
		);
		const a = await rig.computer(
			"Laptop",
			fakeTailnet({
				peers: [studioNode()],
				whois: new Map([[LOOPBACK, { nodeId: "nSTUDIO", nodeName: "studio", login: LOGIN }]]),
			}),
		);
		for (const c of [b, a]) {
			c.devices.start();
			await c.devices.setHostEnabled(true);
			await until(c, state => state.host.port !== null);
		}
		const first = { studio: b.devices.state().host.port, laptop: a.devices.state().host.port };
		await a.devices.connect("nSTUDIO");
		await b.devices.connect("nLAPTOP");
		await until(a, state => state.hosts[0]?.state === "online");
		await until(b, state => state.hosts[0]?.state === "online");

		await Promise.all([a.devices.setHostEnabled(false), b.devices.setHostEnabled(false)]);
		await until(a, state => state.hosts[0]?.state !== "online");
		await until(b, state => state.hosts[0]?.state !== "online");
		await a.devices.setHostEnabled(true);
		await until(a, state => state.host.port !== null);
		await b.devices.setHostEnabled(true);
		await until(b, state => state.host.port !== null);
		expect({ studio: b.devices.state().host.port, laptop: a.devices.state().host.port }).toEqual({
			studio: first.laptop,
			laptop: first.studio,
		});
		await until(a, state => state.hosts[0]?.state === "online");
		await until(b, state => state.hosts[0]?.state === "online");
	}, 20_000);
});

describe("a host link after the computer wakes or the network returns", () => {
	/** A relay a test can silence: both directions drop every byte but the connections stay open, as a dead path does. */
	async function silenceableRelay(target: number): Promise<{ port: number; silence: { on: boolean } }> {
		const silence = { on: false };
		const server = createServer(inbound => {
			const outbound = connect({ host: LOOPBACK, port: target });
			held.push(inbound, outbound);
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
		servers.push(server);
		const { promise, resolve } = Promise.withResolvers<void>();
		server.listen(0, LOOPBACK, () => resolve());
		await promise;
		return { port: (server.address() as AddressInfo).port, silence };
	}

	it("a wake drops a silent link within the wake check, so the host shows offline and is dialed again", async () => {
		const hostPort = await rig.pickPort();
		const b = await rig.computer(
			"Studio",
			fakeTailnet({ whois: new Map([[LOOPBACK, { nodeId: "nLAPTOP", nodeName: "laptop", login: LOGIN }]]) }),
		);
		b.devices.start();
		await b.devices.setHostEnabled(true);
		await until(b, state => state.host.port !== null);
		const relay = await silenceableRelay(hostPort);
		process.env.OMP_GUI_REMOTE_PORT = String(relay.port);
		const a = await rig.computer("Laptop", fakeTailnet({ peers: [studioNode()] }));
		a.devices.start();
		await a.devices.connect("nSTUDIO");
		await until(a, state => state.hosts[0]?.state === "online");
		await fakeCoreTimers(["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]);
		relay.silence.on = true;

		a.devices.wake("resume");
		// The check runs in the core on its own clock; this side's clock moves by the same window.
		await advanceCoreTimers(WAKE_CHECK_MS);

		await until(a, state => state.hosts[0]?.state !== "online");
	});

	it("the tailnet poll wakes a link at once when its host's node comes back online", async () => {
		const { a, b } = await rig.connected();
		await fakeCoreTimers(["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]);
		await b.devices.setHostEnabled(false);
		await until(a, state => state.hosts[0]?.state === "offline");
		const node = a.fake.peers[0];
		if (!node) throw new Error("expected the host's node");
		node.online = false;
		await a.devices.tailscaleAction("start-app");

		await b.devices.setHostEnabled(true);
		node.online = true;
		await a.devices.tailscaleAction("start-app");

		// The retry timer is frozen: only the poll's wake can have started this attempt.
		expect(a.devices.state().hosts[0]?.state).not.toBe("offline");
		await until(a, state => state.hosts[0]?.state === "online");
	});

	it("a host that lost and regained its addresses listens again while a device stays connected", async () => {
		const { a, b } = await rig.connected();
		// A status read that finds Tailscale stopped, or gets no answer, leaves the host no address to listen on.
		b.fake.phase = "not-running";
		await b.devices.tailscaleAction("start-app");
		expect(b.devices.state().host.port).toBeNull();

		b.fake.phase = "ready";
		await b.devices.tailscaleAction("start-app");

		const port = b.devices.state().host.port;
		expect(port).not.toBeNull();
		expect((await probeHost(`${LOOPBACK}:${port}`)).ok).toBe(true);
		expect(a.devices.state().hosts[0]?.state).toBe("online");
	});
});

describe("after the core process ended", () => {
	it("listens as a host again and links to its host again, requests going through", async () => {
		const { a, b, hostId } = await rig.connected();
		// A crash looks the same as a stop: the devices instances, the host's listener and every client's loop go with it.
		await stopCore();
		expect(a.devices.state().hosts[0]?.state).not.toBe("online");
		expect(b.devices.state().host.port).toBeNull();

		await until(b, state => state.host.port !== null, 30_000);
		await until(a, state => state.hosts[0]?.state === "online", 30_000);
		await until(b, state => state.host.peers[0]?.online === true, 30_000);
		b.services.call.mockImplementation(async (_peer, method) => (method === "test.echo" ? { echoed: true } : null));
		expect(await a.devices.request(hostId, "test.echo", {})).toEqual({ echoed: true });
		// The host's own state kept what it was told: still sharing, still named.
		expect(b.devices.state().host).toMatchObject({ enabled: true, name: "Studio" });
	}, 60_000);
});

describe("code-paired computers", () => {
	it("keeps a host found on the tailnet, forgets the rest once, and binds a code-paired device on first contact", async () => {
		const port = await rig.pickPort();
		const bDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-legacy-b-"));
		const aDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-legacy-a-"));
		dirs.push(bDir, aDir);
		const hostIdentity = await loadIdentity(bDir);
		const deviceIdentity = await loadIdentity(aDir);
		await peerStore(bDir).put({
			deviceId: deviceIdentity.deviceId,
			name: "Laptop",
			staticPub: deviceIdentity.publicKey,
			nodeId: null,
			login: null,
			pairedAt: 1,
			limits: { requestsPerDay: 9 },
		});
		const hosts = hostStore(aDir);
		const legacy = { staticPub: hostIdentity.publicKey, nodeId: null, pairedAt: 1 };
		await hosts.put({
			...legacy,
			deviceId: hostIdentity.deviceId,
			name: "Studio",
			addresses: [`${LOOPBACK}:${port}`],
		});
		await hosts.put({ ...legacy, deviceId: "gone", name: "Old desk", addresses: ["192.168.1.20:47821"] });

		const b = await rig.computer(
			"Studio",
			fakeTailnet({ whois: new Map([[LOOPBACK, { nodeId: "nLAPTOP", nodeName: "laptop", login: LOGIN }]]) }),
			{ userData: bDir },
		);
		await b.devices.setHostEnabled(true);
		const a = await rig.computer("Laptop", fakeTailnet({ peers: [studioNode()] }), { userData: aDir });
		a.devices.start();

		const state = await until(a, next => next.hosts.length === 1 && next.hosts[0]?.state === "online");
		expect(state.forgotten).toEqual(["Old desk"]);
		expect((await hostStore(aDir).get(hostIdentity.deviceId))?.nodeId).toBe("nSTUDIO");
		const peers = (await until(b, next => next.host.peers[0]?.online === true)).host.peers;
		expect(await peerStore(bDir).get(deviceIdentity.deviceId)).toMatchObject({ nodeId: "nLAPTOP", login: LOGIN });
		expect(peers[0]?.limits).toEqual({ requestsPerDay: 9 });

		a.devices.dismissForgotten();
		expect(a.devices.state().forgotten).toEqual([]);
	});

	it("keeps a host code pairing stored by its LAN address and old ports, and reaches it at its tailnet address", async () => {
		// The real case: the Mac stored only `192.168.0.2:54155` and `:56613` (LAN address, ephemeral ports of the old
		// fallback); after a reboot the PC listens on its tailnet address and the usual port, and Tailscale reports the
		// LAN address only as the node's endpoint (`CurAddr`), never among its TailscaleIPs.
		await rig.pickPort();
		const bDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-legacy-b-"));
		const aDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-legacy-a-"));
		dirs.push(bDir, aDir);
		const hostIdentity = await loadIdentity(bDir);
		const deviceIdentity = await loadIdentity(aDir);
		await peerStore(bDir).put({
			deviceId: deviceIdentity.deviceId,
			name: "Laptop",
			staticPub: deviceIdentity.publicKey,
			nodeId: null,
			login: null,
			pairedAt: 1,
		});
		const hosts = hostStore(aDir);
		const legacy = { staticPub: generateKeyPair().publicKey, nodeId: null, pairedAt: 1, addresses: [] };
		await hosts.put({
			deviceId: hostIdentity.deviceId,
			name: "Office PC",
			staticPub: hostIdentity.publicKey,
			nodeId: null,
			addresses: ["192.168.0.2:54155", "192.168.0.2:56613"],
			pairedAt: 1,
		});
		// Found by its announced name only (case aside); its key is checked at its first connection.
		await hosts.put({ ...legacy, deviceId: "named", name: "DESKTOP-91ID999" });

		const b = await rig.computer(
			"Office PC",
			fakeTailnet({ whois: new Map([[LOOPBACK, { nodeId: "nLAPTOP", nodeName: "laptop", login: LOGIN }]]) }),
			{ userData: bDir },
		);
		await b.devices.setHostEnabled(true);
		const a = await rig.computer(
			"Laptop",
			fakeTailnet({
				peers: [
					studioNode({ nodeId: "nPC", name: "office", endpoints: ["192.168.0.2"] }),
					studioNode({ nodeId: "nNAMED", name: "desktop-91id999", ips: ["100.64.0.77"] }),
				],
			}),
			{ userData: aDir },
		);
		a.devices.start();

		await until(a, next => next.hosts.find(host => host.deviceId === hostIdentity.deviceId)?.state === "online");
		expect(a.devices.state().forgotten).toEqual([]);
		const kept = hostStore(aDir);
		expect(await kept.get(hostIdentity.deviceId)).toMatchObject({ nodeId: "nPC" });
		expect((await kept.get(hostIdentity.deviceId))?.addresses[0]).toMatch(/^127\.0\.0\.1:\d+$/);
		expect((await kept.get("named"))?.nodeId).toBe("nNAMED");
	});
});

describe("Tailscale's side", () => {
	it("reports Tailscale missing or signed out, and a host listens nowhere then", async () => {
		const b = await rig.computer("Studio", fakeTailnet({ phase: "needs-login" }));
		b.devices.start();
		await until(b, state => state.tailnet === "needs-login");
		const state = await b.devices.setHostEnabled(true);
		expect(state.host.port).toBeNull();
		expect(state.host.listenError).toBeNull();
		expect(await rejectionCode(b.devices.connect("nSTUDIO"))).toBe("remote_tailscale_off");
	});
});

describe("the tabs a host keeps for this device", () => {
	const KEPT = {
		rtab: "lost",
		formerRtabs: ["older"],
		sessionPath: "/host/sessions/lost.jsonl",
		cwd: "/host/work",
		kind: "agent",
		state: "running",
	} as const;

	it("asks the host with `tabs.kept` and reads its answer, ignoring an entry it cannot read", async () => {
		const { a, b, hostId } = await rig.connected();
		b.services.call.mockImplementation(async (_peer, method) =>
			method === "tabs.kept" ? { tabs: [KEPT, { rtab: "no-session" }] } : null,
		);
		expect(await a.devices.keptTabs(hostId)).toEqual([KEPT]);
		expect(b.services.call.mock.calls.some(call => call[1] === "tabs.kept")).toBe(true);
	});

	it("hears the sessions the host deletes as it deletes them, and asks which of its tabs' sessions are deleted", async () => {
		const { a, b, hostId } = await rig.connected();
		const heard: Array<[string, string[]]> = [];
		a.devices.onHostSessionsDeleted((host, paths) => heard.push([host, paths]));
		b.services.call.mockImplementation(async (_peer, method, params) =>
			method === "sessions.deleted"
				? { paths: SessionsDeletedParams.parse(params).paths.filter(path => path.includes("gone")) }
				: null,
		);
		expect(await a.devices.deletedOnHost(hostId, ["/s/gone.jsonl", "/s/kept.jsonl"])).toEqual(["/s/gone.jsonl"]);
		const conn = b.services.call.mock.calls.find(call => call[1] === "sessions.deleted")?.[3] as HostConnection;
		conn.emit(SESSIONS_DELETED_EVENT, { paths: ["/s/a.jsonl", 7, "/s/b.jsonl"] });
		conn.emit(SESSIONS_DELETED_EVENT, { paths: [] });
		conn.emit(SESSIONS_DELETED_EVENT, "not a list");
		await vi.waitFor(() => expect(heard).toEqual([[hostId, ["/s/a.jsonl", "/s/b.jsonl"]]]));
	});

	it("ignores a host that does not know `sessions.deleted` (an older OMPdesk)", async () => {
		const { a, b, hostId } = await rig.connected();
		b.services.call.mockImplementation(async () => {
			throw codedError("unsupported", "Unknown method sessions.deleted");
		});
		expect(await a.devices.deletedOnHost(hostId, ["/s/a.jsonl"])).toBeNull();
	});

	it("holds the host's session summaries: read as the link comes up, a delta on the held version applied, any other version read whole, quiet while offline", async () => {
		const { a, b } = await rig.pair();
		let whole = { version: "e.1", sessions: [summary("/s/a.jsonl")] };
		b.services.call.mockImplementation(async (_peer, method) => (method === "sessions.summaries" ? whole : null));
		const { deviceId } = await a.devices.connect("nSTUDIO");
		await vi.waitFor(() => expect(a.devices.summaries(deviceId)).toEqual(whole));
		expect(summariesPushed(a)).toEqual([{ device: deviceId, change: whole }]);

		// A delta made on the version held applies and goes on to the windows with the device.
		const conn = b.services.call.mock.calls.find(call => call[1] === "sessions.summaries")?.[3] as HostConnection;
		const delta = { base: "e.1", version: "e.2", set: [summary("/s/b.jsonl", "waiting")], remove: ["/s/a.jsonl"] };
		conn.emit(SUMMARIES_EVENT, delta);
		await vi.waitFor(() => expect(summariesPushed(a)).toHaveLength(2));
		expect(summariesPushed(a)[1]).toEqual({ device: deviceId, change: delta });
		expect(a.devices.summaries(deviceId)).toEqual({ version: "e.2", sessions: delta.set });

		// A delta on another version: it missed a change, so it reads the whole set and broadcasts that.
		whole = { version: "e.7", sessions: [summary("/s/c.jsonl")] };
		conn.emit(SUMMARIES_EVENT, { base: "e.5", version: "e.6", set: [], remove: [] });
		await vi.waitFor(() => expect(summariesPushed(a)).toHaveLength(3));
		expect(summariesPushed(a)[2]).toEqual({ device: deviceId, change: whole });
		expect(a.devices.summaries(deviceId)).toEqual(whole);

		// While the link is down nobody knows what the host does: an empty set goes out and none is held.
		await b.devices.setHostEnabled(false);
		await until(a, state => state.hosts[0]?.state !== "online");
		expect(a.devices.summaries(deviceId)).toBeNull();
		expect(summariesPushed(a).at(-1)).toEqual({ device: deviceId, change: { version: "offline", sessions: [] } });
	});

	it("knows the host's own Mobile web address: read as the link comes up, then as the host pushes it", async () => {
		const { a, b } = await rig.pair();
		b.services.call.mockImplementation(async (_peer, method) =>
			method === "host.mobileWeb.link" ? { url: "https://studio.tail1234.ts.net:8443" } : null,
		);
		await a.devices.connect("nSTUDIO");
		const read = await until(a, state => state.hosts[0]?.webUrl !== undefined);
		expect(read.hosts[0]?.webUrl).toBe("https://studio.tail1234.ts.net:8443");

		const conn = b.services.call.mock.calls.find(call => call[1] === "host.mobileWeb.link")?.[3] as HostConnection;
		conn.emit(MOBILE_WEB_LINK_EVENT, { url: null });
		const off = await until(a, state => state.hosts[0]?.webUrl === undefined);
		expect(off.hosts[0]?.webUrl).toBeUndefined();
		// Never an address that is not https.
		conn.emit(MOBILE_WEB_LINK_EVENT, { url: "http://studio:47831" });
		await eventsHandled(a, b, conn);
		const after = a.devices.state();
		expect(after.hosts[0]?.webUrl).toBeUndefined();
	});

	it("tells this computer's windows once when a host's models.yml changed by itself, and sends this computer's own change to its devices", async () => {
		const { a, b } = await rig.connected();
		await vi.waitFor(() =>
			expect(b.services.call.mock.calls.some(call => call[1] === "sessions.summaries")).toBe(true),
		);
		const conn = b.services.call.mock.calls.find(call => call[1] === "sessions.summaries")?.[3] as HostConnection;
		conn.emit(MODELS_CHANGED_EVENT, {});
		await vi.waitFor(() =>
			expect(a.broadcasts.filter(entry => entry.channel === "models-config:changed")).toHaveLength(1),
		);

		b.devices.hostModelsChanged();
		expect(b.services.modelsChanged).toHaveBeenCalledTimes(1);
	});

	it("shows no live state from a host that does not know summaries (an older OMPdesk)", async () => {
		const { a, b } = await rig.pair();
		b.services.call.mockImplementation(async () => {
			throw codedError("unsupported", "Unknown method sessions.summaries");
		});
		const { deviceId } = await a.devices.connect("nSTUDIO");
		await until(a, state => state.hosts[0]?.state === "online");
		await vi.waitFor(() =>
			expect(b.services.call.mock.calls.some(call => call[1] === "sessions.summaries")).toBe(true),
		);
		// A later request on the same link answers after the refused read did: nothing is left in flight.
		expect(await a.devices.keptTabs(deviceId)).toBeNull();
		expect(a.devices.summaries(deviceId)).toBeNull();
		expect(summariesPushed(a)).toEqual([]);
	});

	it("answers null for a host that does not know the method (an older OMPdesk), and rejects for one that is away", async () => {
		const { a, b, hostId } = await rig.connected();
		b.services.call.mockImplementation(async () => {
			throw codedError("unsupported", "Unknown method tabs.kept");
		});
		expect(await a.devices.keptTabs(hostId)).toBeNull();
		expect(await rejectionCode(a.devices.keptTabs("nobody"))).toBe("remote_unknown_device");
	});
});

describe("agent browsing's tunnel to a host tab's relay", () => {
	/** The host's connection to this device, as the host's services see it, and what it was asked, newest last. */
	async function tunnelled() {
		const connected = await rig.connected();
		const { b } = connected;
		await vi.waitFor(() =>
			expect(b.services.call.mock.calls.some(call => call[1] === "sessions.summaries")).toBe(true),
		);
		const conn = b.services.call.mock.calls.find(call => call[1] === "sessions.summaries")?.[3] as HostConnection;
		const asked = () =>
			b.services.call.mock.calls
				.filter(call => String(call[1]).startsWith("host.previewRelay."))
				.map(call => [call[1], call[2]]);
		return { ...connected, conn, asked };
	}

	it("opens on the host, carries frames both ways and tells the host when it closes", async () => {
		const { a, hostId, conn, asked } = await tunnelled();
		const socket = a.devices.previewRelay(hostId, "t1");
		const heard: string[] = [];
		const closed = vi.fn();
		socket.onMessage(data => heard.push(data));
		socket.onClose(closed);
		await socket.ready;
		expect(socket.isOpen).toBe(true);
		expect(asked()).toEqual([["host.previewRelay.open", { rtab: "t1" }]]);

		socket.send('{"t":"hello"}');
		socket.send('{"t":"cdpEvent"}');
		await vi.waitFor(() => expect(asked()).toHaveLength(3));
		expect(asked().slice(1)).toEqual([
			["host.previewRelay.send", { rtab: "t1", data: '{"t":"hello"}' }],
			["host.previewRelay.send", { rtab: "t1", data: '{"t":"cdpEvent"}' }],
		]);

		conn.emit(PREVIEW_RELAY_EVENT, { kind: "message", rtab: "t1", data: '{"t":"rpc"}' });
		// Another tab's frames, and ones the link cannot read, reach nobody.
		conn.emit(PREVIEW_RELAY_EVENT, { kind: "message", rtab: "t2", data: "other" });
		conn.emit(PREVIEW_RELAY_EVENT, { kind: "message", rtab: "t1" });
		await vi.waitFor(() => expect(heard).toEqual(['{"t":"rpc"}']));

		socket.close();
		expect(closed).toHaveBeenCalledTimes(1);
		expect(socket.isOpen).toBe(false);
		await vi.waitFor(() => expect(asked().at(-1)).toEqual(["host.previewRelay.close", { rtab: "t1" }]));
	});

	it("ends when the host's relay closes, and when the link drops", async () => {
		const { a, b, hostId, conn } = await tunnelled();
		const first = a.devices.previewRelay(hostId, "t1");
		const firstClosed = vi.fn();
		first.onClose(firstClosed);
		await first.ready;
		conn.emit(PREVIEW_RELAY_EVENT, { kind: "close", rtab: "t1" });
		await vi.waitFor(() => expect(firstClosed).toHaveBeenCalledTimes(1));
		expect(first.isOpen).toBe(false);

		const second = a.devices.previewRelay(hostId, "t1");
		const secondClosed = vi.fn();
		second.onClose(secondClosed);
		await second.ready;
		await b.devices.dispose();
		await vi.waitFor(() => expect(secondClosed).toHaveBeenCalledTimes(1));
		expect(() => second.send("late")).toThrow(/not open/);
	});

	it("fails to open when the host has no relay for the tab", async () => {
		const { a, b, hostId } = await tunnelled();
		b.services.call.mockImplementation(async () => {
			throw codedError("relay_unavailable", "This tab has no browser relay running");
		});
		const refused = a.devices.previewRelay(hostId, "t1");
		const closed = vi.fn();
		refused.onClose(closed);
		expect(await rejectionCode(refused.ready)).toBe("relay_unavailable");
		expect(closed).toHaveBeenCalledTimes(1);
		expect(refused.isOpen).toBe(false);
		expect(() => a.devices.previewRelay("unknown-host", "t1")).toThrow(/not paired/);
	});
});
