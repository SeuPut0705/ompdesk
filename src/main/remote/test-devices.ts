/**
 * Test-only rig: RemoteDevices on 127.0.0.1 with a fake Tailscale per computer (what `status --json` and `whois`
 * would say), each with its own userData and prefs. Loopback counts as the tailnet (`loopback: true`, as the e2e
 * harness's `OMP_GUI_TEST_REMOTE_LOOPBACK`), so a host and a device in one process share through real sockets.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { vi } from "vitest";
import type { RemoteState, RemoteTailnetPhase, TailnetComputer } from "../../shared/ipc-types";
import type { TailnetNode, TailscaleStatus } from "../tailscale/status";
import type { TailnetPeer } from "../tailscale/whois";
import { WebBlocks } from "../web/blocks-store";
import { RemoteDevices } from "./devices";
import type { LocalHostServices } from "./host-services";
import { freePortRun } from "./test-ports";

export const LOGIN = "me@example.com";
export const LOOPBACK = "127.0.0.1";

/** What this computer's Tailscale says: its own login and addresses, the other nodes, and who each address is. */
export interface FakeTailnet {
	phase: RemoteTailnetPhase;
	login: string;
	selfIps: string[];
	peers: TailnetNode[];
	whois: Map<string, TailnetPeer>;
}

export function fakeTailnet(patch: Partial<FakeTailnet> = {}): FakeTailnet {
	return { phase: "ready", login: LOGIN, selfIps: [LOOPBACK], peers: [], whois: new Map(), ...patch };
}

function statusOf(tailnet: FakeTailnet): TailscaleStatus | null {
	if (tailnet.phase !== "ready") return null;
	return {
		backendState: "Running",
		backend: "running",
		version: "1.104.1",
		authUrl: null,
		dnsName: null,
		userId: 1,
		login: tailnet.login,
		certDomains: [],
		magicDns: true,
		capabilities: [],
		keyExpiry: null,
		updateAvailable: false,
		phones: [],
		selfIps: tailnet.selfIps,
		selfNodeId: null,
		selfName: null,
		peers: tailnet.peers,
	};
}

export interface Computer {
	devices: RemoteDevices;
	/** Called on every `remote:state` broadcast. */
	listeners: Set<() => void>;
	/** The last `remote:tailnet` push. */
	tailnet: { pushed: TailnetComputer[] };
	prefs: Map<string, unknown>;
	userData: string;
	fake: FakeTailnet;
	blocks: WebBlocks;
	/** The person's answer to "approve new devices", and who was asked about. */
	confirm: { answer: boolean; asked: string[] };
	allowed: string[];
	/** The fake host services: `call`'s 4th argument is the connection a device's request came on. */
	services: { call: ReturnType<typeof vi.fn> };
}

export class DevicesRig {
	readonly #dirs: string[] = [];
	readonly #running: RemoteDevices[] = [];
	readonly #savedPort = process.env.OMP_GUI_REMOTE_PORT;

	/** A run of free ports (`freePortRun`); the host takes its first (or a successor) and the device probes the same list. */
	async pickPort(): Promise<number> {
		const port = await freePortRun();
		process.env.OMP_GUI_REMOTE_PORT = String(port);
		return port;
	}

	async computer(
		name: string,
		fake: FakeTailnet,
		options: { userData?: string; prefs?: Map<string, unknown>; services?: LocalHostServices } = {},
	): Promise<Computer> {
		const dir = options.userData ?? (await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-devices-")));
		if (!options.userData) this.#dirs.push(dir);
		const prefs = options.prefs ?? new Map<string, unknown>();
		if (!prefs.has("remote.deviceName")) prefs.set("remote.deviceName", name);
		const listeners = new Set<() => void>();
		const tailnet = { pushed: [] as TailnetComputer[] };
		const blocks = new WebBlocks(dir);
		const confirm = { answer: true, asked: [] as string[] };
		const allowed = [LOGIN];
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
			broadcast: (channel, data) => {
				if (channel === "remote:state") for (const listener of [...listeners]) listener();
				if (channel === "remote:tailnet") tailnet.pushed = structuredClone(data as TailnetComputer[]);
			},
			services: options.services ?? (services as unknown as LocalHostServices),
			machineInfo: () => ({ platform: "darwin", ompVersion: "18.8.0", home: "/home/u", sep: "/" }),
			offlineMessage: () => "offline",
			stalledMessage: device => `${device} stalled`,
			powerSaveBlocker: { start: () => 1, stop: () => {} },
			tailnet: {
				status: async () => statusOf(fake),
				phase: async () => fake.phase,
				whois: async ip => fake.whois.get(ip) ?? null,
			},
			allowedUsers: () => allowed,
			adoptLogin: () => {},
			blocks: () => blocks,
			confirm: async details => {
				confirm.asked.push(details.name);
				return confirm.answer;
			},
			tailscaleAction: async () => {},
			loopback: true,
		});
		this.#running.push(devices);
		return { devices, listeners, tailnet, prefs, userData: dir, fake, blocks, confirm, allowed, services };
	}

	/** A host B sharing itself and a device A that sees it as node `nSTUDIO`; B sees A as node `nLAPTOP`. */
	async pair(hostServices?: LocalHostServices): Promise<{ a: Computer; b: Computer }> {
		await this.pickPort();
		const b = await this.computer(
			"Studio",
			fakeTailnet({ whois: new Map([[LOOPBACK, { nodeId: "nLAPTOP", nodeName: "laptop", login: LOGIN }]]) }),
			{ services: hostServices },
		);
		b.devices.start();
		await b.devices.setHostEnabled(true);
		await until(b, state => state.host.port !== null);
		const a = await this.computer("Laptop", fakeTailnet({ peers: [studioNode()] }));
		a.devices.start();
		return { a, b };
	}

	/** Pair, then connect A to B; resolves once both sides see the link. */
	async connected(hostServices?: LocalHostServices): Promise<{ a: Computer; b: Computer; hostId: string }> {
		const { a, b } = await this.pair(hostServices);
		const view = await a.devices.connect("nSTUDIO");
		await until(a, state => state.hosts[0]?.state === "online");
		await until(b, state => state.host.peers[0]?.online === true);
		return { a, b, hostId: view.deviceId };
	}

	async dispose(): Promise<void> {
		for (const devices of this.#running.splice(0)) await devices.dispose();
		for (const dir of this.#dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
		if (this.#savedPort === undefined) delete process.env.OMP_GUI_REMOTE_PORT;
		else process.env.OMP_GUI_REMOTE_PORT = this.#savedPort;
	}
}

export function studioNode(patch: Partial<TailnetNode> = {}): TailnetNode {
	return {
		nodeId: "nSTUDIO",
		name: "studio",
		ips: [LOOPBACK],
		os: "macOS",
		online: true,
		login: LOGIN,
		endpoints: [],
		...patch,
	};
}

/** Resolves once `done` holds for the computer's state, checked on every broadcast; the timer is only a failure deadline. */
export function until(c: Computer, done: (state: RemoteState) => boolean): Promise<RemoteState> {
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
