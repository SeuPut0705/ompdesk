/**
 * Two OMPdesk instances on the fake omp for the remote-device suites: a host (B)
 * that shares itself and a client (A) that pairs with it and runs tabs there.
 * Each instance has its own profile, userData, discovery port and project; a
 * relaunch reuses all of them. A host that is relaunched needs a fixed port
 * (`fixedPort`), since A reconnects to the address it paired with. A pairing
 * through `linkProxy` lets a test cut the link while both apps keep running.
 */
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { _electron as electron } from "playwright";
import { fixtureOmp, walkRemotePicker } from "./harness";

export type Language = "en" | "ko";
export type Theme = "light" | "dark";

export interface RemoteProfile {
	root: string;
	project: string;
	desktop: string;
	/** The fixture omp's command log (OMP_GUI_TEST_RECORD). */
	record: string;
	env: Record<string, string>;
}

export interface RemoteInstance {
	app: ElectronApplication;
	page: Page;
	profile: RemoteProfile;
	errors: string[];
}

/** A TCP port free right now, for a host that must keep its address across a relaunch. */
export async function freePort(): Promise<number> {
	const server = net.createServer();
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	if (!address || typeof address === "string") throw new Error("expected a TCP address");
	return address.port;
}

/** A TCP relay A pairs through: `drop()` cuts the link (and refuses new ones) until `restore()`. */
export interface LinkProxy {
	/** The address A pairs with (and keeps dialing). */
	readonly address: string;
	drop(): Promise<void>;
	restore(): Promise<void>;
	close(): Promise<void>;
}

export async function linkProxy(targetPort: number): Promise<LinkProxy> {
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
				socket.pipe(peer);
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
	return { address: `127.0.0.1:${port}`, drop: stop, restore: listen, close: stop };
}

export async function makeRemoteProfile(
	parent: string,
	name: string,
	options: {
		language: Language;
		theme: Theme;
		discoveryPort: number;
		/** The host's listening port; 0 (default) = ephemeral. */
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
		OMP_GUI_REMOTE_PORT: String(options.port ?? 0),
		OMP_GUI_REMOTE_DISCOVERY_PORT: String(options.discoveryPort),
		...options.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, project: await fs.realpath(project), desktop, record, env };
}

/**
 * Launch (or relaunch) on the profile's userData. `project: false` restores the saved layout
 * instead of opening the project; `ready: false` returns once the window exists.
 */
export async function launchRemote(
	profile: RemoteProfile,
	options: { project?: boolean; ready?: boolean } = {},
): Promise<RemoteInstance> {
	const args = [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js")];
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

/**
 * B shares itself under `name`; A pairs through the remote API (the pairing UI is remote-devices.e2e.ts's),
 * at B's own port unless `address` (a `linkProxy`'s) is given.
 */
export async function pair(host: Page, client: Page, name: string, address?: string): Promise<string> {
	await host.evaluate(value => window.omp.remote.setDeviceName(value), name);
	await host.evaluate(() => window.omp.remote.setHostEnabled(true));
	await expect.poll(async () => (await host.evaluate(() => window.omp.remote.getState())).host.code).toBeTruthy();
	const { host: state } = await host.evaluate(() => window.omp.remote.getState());
	const paired = await client.evaluate(payload => window.omp.remote.pair(payload), {
		address: address ?? `127.0.0.1:${state.port}`,
		code: state.code ?? "",
	});
	return paired.deviceId;
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
