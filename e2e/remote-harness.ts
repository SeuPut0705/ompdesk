/**
 * Two OMPdesk instances on the fake omp for the remote-device suites: a host (B) that shares itself and a client
 * (A) that connects to it over the "tailnet" and runs tabs there. Each instance has its own profile, userData, port,
 * project and fake Tailscale (`fixtureTailscale`), on which 127.0.0.1 is the tailnet
 * (`OMP_GUI_TEST_REMOTE_LOOPBACK=1`): the host listens there, and every app sees one peer node at 127.0.0.1 (the
 * host's `whois` says who connects; the client's `status` lists the host to probe). A client is made with the
 * host's port (`port: host.port`) or a `linkProxy`'s, since it probes that port and its successors. A connection
 * through `linkProxy` lets a test cut the link while both apps keep running. No pairing code anywhere.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { assertAppBuilt } from "../scripts/e2e-app-entry";
import { freePortRun } from "../src/main/remote/test-ports";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { fixtureOmp, walkRemotePicker } from "./harness";

export type Language = "en" | "ko";
export type Theme = "light" | "dark";

/** The Tailscale account every remote suite's apps are signed in to. */
export const REMOTE_LOGIN = "me@example.com";

export interface RemoteProfile {
	root: string;
	project: string;
	desktop: string;
	/** The fixture omp's command log (OMP_GUI_TEST_RECORD). */
	record: string;
	env: Record<string, string>;
	/** The port this app listens on as a host, and probes as a client. */
	port: number;
	/** This app's fake Tailscale: `tailscale.update({...})` changes what it says. */
	tailscale: FixtureTailscale;
}

export interface RemoteInstance {
	app: ElectronApplication;
	page: Page;
	profile: RemoteProfile;
	errors: string[];
}

/**
 * A TCP port free right now, for a host that must keep its address across a relaunch: the first of a free run of its
 * candidates below the ephemeral range. A `listen(0)` port lets a parallel worker's app take the next candidate, and
 * the device then connects to that app instead (`freePortRun`).
 */
export function freePort(): Promise<number> {
	return freePortRun();
}

/**
 * A TCP relay A pairs through: `drop()` cuts the link (and refuses new ones) until `restore()`. `setLatency(ms)`
 * holds every chunk that long in each direction (in order) from then on, as a link between two computers far
 * apart would.
 */
export interface LinkProxy {
	/** The address A pairs with (and keeps dialing). */
	readonly address: string;
	drop(): Promise<void>;
	restore(): Promise<void>;
	setLatency(ms: number): void;
	close(): Promise<void>;
}

export async function linkProxy(targetPort: number): Promise<LinkProxy> {
	let latency = 0;
	const port = await freePort();
	const sockets = new Set<net.Socket>();
	let server: net.Server | null = null;
	const listen = async (): Promise<void> => {
		if (server) return;
		const next = net.createServer(inbound => {
			const outbound = net.connect(targetPort, "127.0.0.1");
			for (const [socket, peer] of [
				[inbound, outbound],
				[outbound, inbound],
			] as const) {
				sockets.add(socket);
				socket.on("error", () => {});
				socket.on("close", () => {
					sockets.delete(socket);
					peer.destroy();
				});
				socket.on("data", (chunk: Buffer) => {
					if (latency === 0) {
						if (!peer.destroyed) peer.write(chunk);
						return;
					}
					setTimeout(() => {
						if (!peer.destroyed) peer.write(chunk);
					}, latency);
				});
			}
		});
		const listening = Promise.withResolvers<void>();
		next.once("error", listening.reject);
		next.listen(port, "127.0.0.1", listening.resolve);
		await listening.promise;
		server = next;
	};
	// Closed, not just emptied: a dial while the link is down is refused like an unreachable host's.
	const stop = async (): Promise<void> => {
		const current = server;
		server = null;
		for (const socket of sockets) socket.destroy();
		if (!current) return;
		const closed = Promise.withResolvers<void>();
		current.close(() => closed.resolve());
		await closed.promise;
	};
	await listen();
	return {
		address: `127.0.0.1:${port}`,
		drop: stop,
		restore: listen,
		setLatency: ms => {
			latency = ms;
		},
		close: stop,
	};
}

/** A fake Tailscale on which this app is node `n-<name>`, signed in as `REMOTE_LOGIN`, with one peer at 127.0.0.1. */
export function remoteTailscale(root: string, name: string): Promise<FixtureTailscale> {
	return fixtureTailscale(root, {
		login: REMOTE_LOGIN,
		selfIps: ["127.0.0.1"],
		selfStableId: `n-${name}`,
		peers: [
			{ hostName: "peer", os: "macOS", online: true, userId: 1001, ip: "127.0.0.1", stableId: `n-peer-${name}` },
		],
	});
}

export async function makeRemoteProfile(
	parent: string,
	name: string,
	options: {
		language: Language;
		theme: Theme;
		/** Listened on as a host and probed as a client: a client takes its host's (or a `linkProxy`'s). Default: free. */
		port?: number;
		env?: Record<string, string>;
		prefs?: Record<string, unknown>;
	},
): Promise<RemoteProfile> {
	const root = path.join(parent, name);
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await fs.mkdir(root);
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: options.language,
			themeName: options.theme,
			firstRunComplete: true,
			...options.prefs,
		}),
	);
	const record = path.join(root, "record.jsonl");
	const bin = await fixtureOmp(root);
	// Terminals and content search run stock's natives through the stock helper (on the host for a remote tab).
	const natives =
		process.env.OMP_GUI_TEST_NATIVES ||
		path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
	await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "junction");
	const tailscale = await remoteTailscale(root, name);
	const port = options.port ?? (await freePort());
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: bin,
		OMP_GUI_TEST_RECORD: record,
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_REMOTE_PORT: String(port),
		OMP_GUI_TEST_REMOTE_LOOPBACK: "1",
		...tailscale.env,
		...options.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, project: await fs.realpath(project), desktop, record, env, port, tailscale };
}

/**
 * Launch (or relaunch) on the profile's userData. `project: false` restores the saved layout
 * instead of opening the project; `ready: false` returns once the window exists.
 */
export async function launchRemote(
	profile: RemoteProfile,
	options: { project?: boolean; ready?: boolean } = {},
): Promise<RemoteInstance> {
	const args = [assertAppBuilt()];
	if (options.project !== false) args.push(profile.project);
	args.push(`--user-data-dir=${profile.desktop}`);
	const app = await electron.launch({ args, env: profile.env });
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.remote != null);
	if (options.ready !== false) {
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
	}
	return { app, page, profile, errors };
}

/** A's view of the tailnet: the first computer that shares OMPdesk and lets A in (its node id), once one does. */
export async function availableHost(client: Page): Promise<string> {
	let nodeId = "";
	await expect
		.poll(
			async () => {
				const computers = await client.evaluate(() => window.omp.remote.watchTailnet(true));
				nodeId = computers.find(computer => computer.state === "available")?.nodeId ?? "";
				return nodeId;
			},
			{ timeout: 30_000 },
		)
		.not.toBe("");
	return nodeId;
}

/**
 * B shares itself under `name`; A finds it on the tailnet and connects through the remote API (the UI is
 * remote-devices.e2e.ts's). No code: Tailscale says who A is.
 */
export async function connectHost(host: Page, client: Page, name: string): Promise<string> {
	await host.evaluate(value => window.omp.remote.setDeviceName(value), name);
	await host.evaluate(() => window.omp.remote.setHostEnabled(true));
	await expect.poll(async () => (await host.evaluate(() => window.omp.remote.getState())).host.port).toBeTruthy();
	const nodeId = await availableHost(client);
	const view = await client.evaluate(id => window.omp.remote.connect(id), nodeId);
	return view.deviceId;
}

/** A: open a tab on B in `folder` through the sidebar's device section and its folder picker. */
export async function openHostFolder(client: Page, deviceId: string, folder: string): Promise<string> {
	const before = new Set((await client.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId));
	const section = client.locator(`[data-sidebar-device="${deviceId}"]`);
	await expect(section).toHaveAttribute("data-device-state", "online");
	await section.locator(`[data-sidebar-device-add="${deviceId}"]`).click();
	const picker = client.locator("[role=dialog]").filter({ has: client.locator("[data-remote-picker-path]") });
	await walkRemotePicker(picker, folder);
	await picker.locator("[data-remote-picker-open]").click();
	await expect(picker).toHaveCount(0);
	let tabId = "";
	await expect
		.poll(
			async () => {
				const tab = (await client.evaluate(() => window.omp.tabs.list())).find(
					tab => tab.device === deviceId && !before.has(tab.tabId),
				);
				tabId = tab?.tabId ?? "";
				return tab?.status;
			},
			{ timeout: 60_000 },
		)
		.toBe("ready");
	return tabId;
}
