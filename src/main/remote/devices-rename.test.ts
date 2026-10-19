/**
 * One name per device, renamable at any time from either side: two RemoteDevices (host B, device A) over real
 * sockets on 127.0.0.1, each with its own userData and prefs.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type { RemoteState } from "../../shared/ipc-types";
import { RemoteDevices } from "./devices";
import type { LocalHostServices } from "./host-services";

const saved = { port: process.env.OMP_GUI_REMOTE_PORT, discovery: process.env.OMP_GUI_REMOTE_DISCOVERY_PORT };
const dirs: string[] = [];
const running: RemoteDevices[] = [];

beforeEach(() => {
	process.env.OMP_GUI_REMOTE_PORT = "0";
	process.env.OMP_GUI_REMOTE_DISCOVERY_PORT = "47898";
});

afterEach(async () => {
	for (const devices of running.splice(0)) await devices.dispose();
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
	for (const [name, value] of [
		["OMP_GUI_REMOTE_PORT", saved.port],
		["OMP_GUI_REMOTE_DISCOVERY_PORT", saved.discovery],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

interface Computer {
	devices: RemoteDevices;
	/** Called on every `remote:state` broadcast. */
	listeners: Set<() => void>;
	prefs: Map<string, unknown>;
	userData: string;
}

async function computer(name: string, userData?: string, prefs = new Map<string, unknown>()): Promise<Computer> {
	const dir = userData ?? (await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-rename-")));
	if (!userData) dirs.push(dir);
	if (!prefs.has("remote.deviceName")) prefs.set("remote.deviceName", name);
	const listeners = new Set<() => void>();
	const services = {
		onRunningChange: vi.fn(() => () => {}),
		attachQuota: vi.fn(),
		disposeAll: vi.fn(),
		runningPeers: () => [],
		dropPeer: vi.fn(),
		call: vi.fn(async () => null),
		disconnected: vi.fn(),
	};
	const devices = new RemoteDevices({
		userData: dir,
		appVersion: "1.0.0",
		prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) },
		broadcast: channel => {
			if (channel === "remote:state") for (const listener of [...listeners]) listener();
		},
		services: services as unknown as LocalHostServices,
		machineInfo: () => ({ platform: "darwin", ompVersion: "18.8.0", home: "/home/u", sep: "/" }),
		offlineMessage: () => "offline",
		stalledMessage: device => `${device} stalled`,
		powerSaveBlocker: { start: () => 1, stop: () => {} },
	});
	running.push(devices);
	return { devices, listeners, prefs, userData: dir };
}

/** Resolves once `done` holds for the computer's state, checked on every broadcast; the timer is only a failure deadline. */
function until(c: Computer, done: (state: RemoteState) => boolean): Promise<RemoteState> {
	const { promise, resolve, reject } = Promise.withResolvers<RemoteState>();
	const check = () => {
		const state = c.devices.state();
		if (!done(state)) return;
		c.listeners.delete(check);
		clearTimeout(deadline);
		resolve(state);
	};
	const deadline = setTimeout(() => {
		c.listeners.delete(check);
		reject(new Error(`gave up: ${JSON.stringify(c.devices.state())}`));
	}, 5_000);
	c.listeners.add(check);
	check();
	return promise;
}

async function pairedPair() {
	const b = await computer("Studio");
	await b.devices.setHostEnabled(true);
	const hostState = await until(b, state => state.host.port !== null && state.host.code !== null);
	const a = await computer("Laptop");
	const view = await a.devices.pair({ address: `127.0.0.1:${hostState.host.port}`, code: hostState.host.code });
	await until(a, state => state.hosts[0]?.state === "online");
	await until(b, state => state.host.peers[0]?.online === true);
	return { a, b, hostId: view.deviceId };
}

describe("device names", () => {
	it("renames the host from the device: the host's own name changes and both sides show it live", async () => {
		const { a, b, hostId } = await pairedPair();
		await a.devices.renameHost({ deviceId: hostId, name: "  Big desk  " });
		expect(b.prefs.get("remote.deviceName")).toBe("Big desk");
		expect(b.devices.state().host.name).toBe("Big desk");
		expect(a.devices.state().hosts[0]?.name).toBe("Big desk");
	});

	it("announces this computer's new name to a connected device and to the host it uses", async () => {
		const { a, b } = await pairedPair();
		b.devices.setDeviceName("Renamed host");
		await until(a, state => state.hosts[0]?.name === "Renamed host");
		a.devices.setDeviceName("Renamed laptop");
		await until(b, state => state.host.peers[0]?.name === "Renamed laptop");
	});

	it("asks a connected device to rename itself, and refuses while it is not connected", async () => {
		const { a, b } = await pairedPair();
		const peerId = b.devices.state().host.peers[0]?.deviceId ?? "";
		b.devices.renamePeer({ deviceId: peerId, name: "Kitchen laptop" });
		await until(a, state => state.host.name === "Kitchen laptop");
		await until(b, state => state.host.peers[0]?.name === "Kitchen laptop");

		await a.devices.dispose();
		await until(b, state => state.host.peers[0]?.online === false);
		let refused: unknown;
		try {
			b.devices.renamePeer({ deviceId: peerId, name: "Gone" });
		} catch (error) {
			refused = error;
		}
		expect(ipcErrorCode(refused)).toBe("remote_offline");
	});

	it("keeps a renamed host's name across the device's relaunch and refuses an empty name", async () => {
		const { a, hostId } = await pairedPair();
		await a.devices.renameHost({ deviceId: hostId, name: "Big desk" });
		await expect(a.devices.renameHost({ deviceId: hostId, name: "   " })).rejects.toMatchObject({});
		await a.devices.dispose();
		const again = await computer("Laptop", a.userData, a.prefs);
		expect(again.devices.state().hosts[0]?.name).toBe("Big desk");
	});
});
