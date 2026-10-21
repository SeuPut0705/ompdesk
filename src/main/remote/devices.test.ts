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
import { generateKeyPair } from "./crypto";
import { HostStore } from "./hosts-store";
import { loadIdentity } from "./identity";
import { PeerStore } from "./peers-store";
import { DevicesRig, fakeTailnet, LOGIN, LOOPBACK, studioNode, until } from "./test-devices";
import { WAKE_CHECK_MS } from "./wire";

const rig = new DevicesRig();
const servers: Server[] = [];
const held: Socket[] = [];
const dirs: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
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
		expect(view.name).toBe("Studio");
		expect(a.tailnet.pushed).toMatchObject([{ nodeId: "nSTUDIO", connected: true }]);
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
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		relay.silence.on = true;

		a.devices.wake("resume");
		await vi.advanceTimersByTimeAsync(WAKE_CHECK_MS);

		expect(a.devices.state().hosts[0]?.state).not.toBe("online");
	});

	it("the tailnet poll wakes a link at once when its host's node comes back online", async () => {
		const { a, b } = await rig.connected();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
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
});

describe("code-paired computers", () => {
	it("keeps a host found on the tailnet, forgets the rest once, and binds a code-paired device on first contact", async () => {
		const port = await rig.pickPort();
		const bDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-legacy-b-"));
		const aDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-legacy-a-"));
		dirs.push(bDir, aDir);
		const hostIdentity = loadIdentity(bDir);
		const deviceIdentity = loadIdentity(aDir);
		new PeerStore(bDir).put({
			deviceId: deviceIdentity.deviceId,
			name: "Laptop",
			staticPub: deviceIdentity.publicKey,
			nodeId: null,
			login: null,
			pairedAt: 1,
			limits: { requestsPerDay: 9 },
		});
		const hosts = new HostStore(aDir);
		const legacy = { staticPub: hostIdentity.publicKey, nodeId: null, pairedAt: 1 };
		hosts.put({ ...legacy, deviceId: hostIdentity.deviceId, name: "Studio", addresses: [`${LOOPBACK}:${port}`] });
		hosts.put({ ...legacy, deviceId: "gone", name: "Old desk", addresses: ["192.168.1.20:47821"] });

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
		expect(new HostStore(aDir).get(hostIdentity.deviceId)?.nodeId).toBe("nSTUDIO");
		const peers = (await until(b, next => next.host.peers[0]?.online === true)).host.peers;
		expect(new PeerStore(bDir).get(deviceIdentity.deviceId)).toMatchObject({ nodeId: "nLAPTOP", login: LOGIN });
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
		const hostIdentity = loadIdentity(bDir);
		const deviceIdentity = loadIdentity(aDir);
		new PeerStore(bDir).put({
			deviceId: deviceIdentity.deviceId,
			name: "Laptop",
			staticPub: deviceIdentity.publicKey,
			nodeId: null,
			login: null,
			pairedAt: 1,
		});
		const hosts = new HostStore(aDir);
		const legacy = { staticPub: generateKeyPair().publicKey, nodeId: null, pairedAt: 1, addresses: [] };
		hosts.put({
			deviceId: hostIdentity.deviceId,
			name: "Office PC",
			staticPub: hostIdentity.publicKey,
			nodeId: null,
			addresses: ["192.168.0.2:54155", "192.168.0.2:56613"],
			pairedAt: 1,
		});
		// Found by its announced name only (case aside); its key is checked at its first connection.
		hosts.put({ ...legacy, deviceId: "named", name: "DESKTOP-91ID999" });

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
		const kept = new HostStore(aDir);
		expect(kept.get(hostIdentity.deviceId)).toMatchObject({ nodeId: "nPC" });
		expect(kept.get(hostIdentity.deviceId)?.addresses[0]).toMatch(/^127\.0\.0\.1:\d+$/);
		expect(kept.get("named")?.nodeId).toBe("nNAMED");
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

	it("answers null for a host that does not know the method (an older OMPdesk), and rejects for one that is away", async () => {
		const { a, b, hostId } = await rig.connected();
		b.services.call.mockImplementation(async () => {
			throw codedError("unsupported", "Unknown method tabs.kept");
		});
		expect(await a.devices.keptTabs(hostId)).toBeNull();
		expect(await rejectionCode(a.devices.keptTabs("nobody"))).toBe("remote_unknown_device");
	});
});
