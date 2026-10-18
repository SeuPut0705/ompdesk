/**
 * A paired phone's tabs survive this computer's relaunch (`src/main/web/web-tab-layouts.ts`, the restore loop
 * before `turnResume.launch()` in `src/main/index.ts`). The built app runs on the fake omp and the fake Tailscale
 * CLI; a phone pairs through the serve prefix (as `mobile-web.e2e.ts` does), opens a tab over /ws, sends a prompt
 * so the tab has a session file, and the app restarts on the same userData, once quit and once SIGKILLed.
 * After it the phone reconnects with its old cookie: GET_TABS lists exactly that tab on the same session file, the
 * desktop window has no tab of it, and the sidebar lists the session once.
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { WebSocket } from "ws";
import type { IpcSpawnTabResult, IpcTabInfo } from "../src/shared/ipc-types";
import { IPC_COMMANDS } from "../src/shared/ipc-types";
import type { RpcResponse } from "../src/shared/rpc-types";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { exitApp, fixtureOmp } from "./harness";

interface Profile {
	root: string;
	desktop: string;
	agent: string;
	project: string;
	env: Record<string, string>;
	tailscale: FixtureTailscale;
}

async function makeProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-tabs-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const tailscale = await fixtureTailscale(root, { backendState: "Running" });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, desktop, agent, project, env, tailscale };
}

/** Launch on the profile's userData with no argv cwd, so a relaunch restores what the last run saved. */
async function launch(profile: Profile): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page };
}

const PHONE_IP = "100.64.0.9";

/** What a phone's request carries when `tailscale serve` hands it on from the published `site` (`host:port`). */
function headersFor(site: string) {
	return {
		host: site,
		origin: `https://${site}`,
		"tailscale-user-login": "seuput@example.com",
		"x-forwarded-for": PHONE_IP,
		"user-agent": "E2EPhone/1.0",
	};
}

function send(
	port: string,
	method: "GET" | "POST",
	pathname: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{
		status: number;
		headers: http.IncomingHttpHeaders;
		body: string;
	}>();
	const req = http.request(
		{
			host: "127.0.0.1",
			port,
			path: pathname,
			method,
			headers: method === "POST" ? { ...headers, "content-type": "application/json" } : headers,
		},
		res => {
			const chunks: Buffer[] = [];
			res.on("data", chunk => chunks.push(chunk as Buffer));
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
			);
		},
	);
	req.on("error", reject);
	req.end(method === "POST" ? JSON.stringify(body) : undefined);
	return promise;
}

/** One of OMPdesk's published serve handlers: its address, the loopback port it proxies to and the secret path. */
interface Site {
	site: string;
	port: string;
	prefix: string;
}

/**
 * OMPdesk's handlers in the fake serve config (the user's own `:443` one is left out). A relaunch whose loopback
 * port differs from the last run's (47831 busy) publishes on the next free address and leaves the old handler.
 */
function sites(tailscale: FixtureTailscale): Site[] {
	return Object.entries(tailscale.scenario().serve.Web ?? {}).flatMap(([site, web]) => {
		const target = web.Handlers["/"]?.Proxy;
		if (!target || site.endsWith(":443")) return [];
		const { port, pathname } = new URL(target);
		return [{ site, port, prefix: pathname.replace(/\/$/, "") }];
	});
}

/** The site that answers a session ticket to `cookie` now. */
async function liveSite(tailscale: FixtureTailscale, cookie: string): Promise<Site | null> {
	for (const candidate of sites(tailscale)) {
		const answer = await send(
			candidate.port,
			"POST",
			`${candidate.prefix}/api/session`,
			{},
			{
				...headersFor(candidate.site),
				cookie,
			},
		).catch(() => null);
		if (answer?.status === 200) return candidate;
	}
	return null;
}

/** The paired phone: one WebSocket on the app's /ws, `call` is `window.omp`'s invoke. */
class Phone {
	readonly #socket: WebSocket;
	readonly #frames: Array<{ t: string; id?: number; ok?: boolean; v?: unknown; e?: unknown }> = [];
	#next = 1;

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.on("message", data => this.#frames.push(JSON.parse(data.toString())));
	}

	static async connect(target: Site, cookie: string): Promise<Phone> {
		const headers = { ...headersFor(target.site), cookie };
		const session = await send(target.port, "POST", `${target.prefix}/api/session`, {}, headers);
		expect(session.status, session.body).toBe(200);
		const { ticket } = JSON.parse(session.body) as { ticket: string };
		const socket = new WebSocket(
			`ws://127.0.0.1:${target.port}${target.prefix}/ws`,
			["ompdesk.v1", `ticket.${ticket}`],
			{ headers },
		);
		const phone = new Phone(socket);
		await once(socket, "open");
		await expect.poll(() => phone.#frames[0]?.t).toBe("hello");
		return phone;
	}

	async call<T>(channel: string, ...args: unknown[]): Promise<T> {
		const id = this.#next++;
		this.#socket.send(JSON.stringify({ t: "inv", id, ch: channel, a: args }));
		await expect
			.poll(() => this.#frames.find(frame => frame.t === "res" && frame.id === id) !== undefined, {
				timeout: 30_000,
				message: `answer to ${channel}`,
			})
			.toBe(true);
		const frame = this.#frames.find(candidate => candidate.t === "res" && candidate.id === id);
		if (!frame?.ok) throw new Error(`${channel} failed: ${JSON.stringify(frame?.e)}`);
		return frame.v as T;
	}

	tabs(): Promise<IpcTabInfo[]> {
		return this.call<IpcTabInfo[]>(IPC_COMMANDS.GET_TABS);
	}

	close(): void {
		this.#socket.terminate();
	}
}

/** Pair the phone the way serve hands its first visit on; its cookie is what a later launch recognizes. */
async function pair(target: Site): Promise<string> {
	const paired = await send(
		target.port,
		"POST",
		`${target.prefix}/api/pair`,
		{ name: "E2E phone" },
		headersFor(target.site),
	);
	expect(paired.status, paired.body).toBe(200);
	const cookie = (paired.headers["set-cookie"]?.[0] ?? "").split(";")[0] ?? "";
	expect(cookie).not.toBe("");
	return cookie;
}

async function sessionFiles(profile: Profile): Promise<string[]> {
	const root = path.join(profile.agent, "sessions");
	const names = await fs.readdir(root, { recursive: true }).catch(() => []);
	return names.filter(name => name.endsWith(".jsonl")).map(name => path.join(root, name));
}

async function savedWebLayouts(profile: Profile): Promise<Record<string, { tabs: Array<{ sessionPath?: string }> }>> {
	try {
		const prefs = JSON.parse(await fs.readFile(path.join(profile.desktop, "prefs.json"), "utf8")) as {
			webTabLayouts?: Record<string, { tabs: Array<{ sessionPath?: string }> }>;
		};
		return prefs.webTabLayouts ?? {};
	} catch {
		return {};
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** SIGKILL of the app's main process: no quit hook, no teardown (interrupted-resume.e2e.ts). */
async function crash(app: ElectronApplication): Promise<void> {
	const pid = await app.evaluate(() => process.pid);
	process.kill(pid, "SIGKILL");
	await expect.poll(() => isRunning(pid), { timeout: 20_000, message: "the killed app must be gone" }).toBe(false);
}

function survivors(root: string): string[] {
	return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter(line => line.includes(root));
}

for (const how of ["quit", "SIGKILL"] as const)
	test(`${how === "quit" ? "@smoke " : ""}A paired phone's tab comes back after the computer restarts (${how}): one tab, the same session, no copy on the desktop`, async () => {
		test.skip(process.platform === "win32", "the fake Tailscale is a shebang script run by bun");
		test.setTimeout(240_000);
		const profile = await makeProfile();
		let current: ElectronApplication | null = null;
		let phone: Phone | null = null;
		try {
			// First run: mobile web on, the phone pairs and opens a tab with a prompt (so the tab has a session file).
			const first = await launch(profile);
			current = first.app;
			await first.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(() => first.page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), {
					timeout: 60_000,
				})
				.toBe("ready");
			const [target] = sites(profile.tailscale);
			if (!target) throw new Error("no serve handler published");
			const cookie = await pair(target);
			phone = await Phone.connect(target, cookie);
			const spawned = await phone.call<IpcSpawnTabResult>(IPC_COMMANDS.SPAWN_TAB, { cwd: profile.project });
			if (!spawned.tabId) throw new Error(`the phone's tab was refused: ${JSON.stringify(spawned)}`);
			const tabId = spawned.tabId;
			// SPAWN_TAB answers as soon as the tab exists; its omp is still starting and refuses a prompt
			// (`sidecar_not_ready`) until it is up, as the phone's composer waits for.
			await expect
				.poll(async () => (await phone?.tabs())?.find(tab => tab.tabId === tabId)?.status, {
					timeout: 60_000,
					message: "the phone's tab is ready",
				})
				.toBe("ready");
			const prompted = await phone.call<RpcResponse>(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, {
				tabId,
				command: { type: "prompt", message: "hello from the phone" },
			});
			expect(prompted.success, prompted.success ? "" : prompted.error).toBe(true);
			await expect
				.poll(async () => (await phone?.tabs())?.find(tab => tab.tabId === tabId)?.sessionPath ?? "", {
					timeout: 60_000,
					message: "the phone's tab names its session file",
				})
				.not.toBe("");
			const sessionPath = (await phone.tabs()).find(tab => tab.tabId === tabId)?.sessionPath ?? "";
			await expect.poll(() => sessionFiles(profile), { timeout: 30_000 }).toEqual([sessionPath]);
			// The layout is on disk under the device's id: a quit or a crash from here on cannot lose it.
			await expect
				.poll(
					async () =>
						Object.values(await savedWebLayouts(profile)).flatMap(layout =>
							layout.tabs.map(tab => tab.sessionPath),
						),
					{ timeout: 30_000 },
				)
				.toEqual([sessionPath]);
			phone.close();
			phone = null;

			if (how === "quit") await exitApp(first.app);
			else {
				await crash(first.app);
				await expect
					.poll(() => survivors(profile.root), { timeout: 20_000, message: "the killed app's children must end" })
					.toEqual([]);
			}
			current = null;

			// Second run on the same userData: the same cookie reconnects and finds the tab again.
			const second = await launch(profile);
			current = second.app;
			await expect
				.poll(async () => (await liveSite(profile.tailscale, cookie)) !== null, {
					timeout: 60_000,
					message: "the relaunched app serves the old cookie",
				})
				.toBe(true);
			const served = await liveSite(profile.tailscale, cookie);
			if (!served) throw new Error("no serve handler after the relaunch");
			phone = await Phone.connect(served, cookie);
			const tabs = await phone.tabs();
			expect(tabs.map(tab => tab.sessionPath)).toEqual([sessionPath]);

			// The desktop window did not take the phone's session as a tab of its own, and the sidebar lists it once.
			const desktopTabs = await second.page.evaluate(() => window.omp.tabs.list());
			expect(desktopTabs.filter(tab => tab.sessionPath === sessionPath)).toEqual([]);
			const rows = second.page.locator(".omp-session-sidebar .omp-sidebar-session-row[data-session-path]");
			// The sidebar opens on its Chat lane; the session belongs to a project, so it lists under Code.
			await second.page.getByRole("button", { name: "Show Code" }).click();
			const group = second.page.locator("[data-workspace-group] button[aria-expanded]").first();
			if ((await group.getAttribute("aria-expanded")) === "false") await group.click();
			await expect
				.poll(() => rows.evaluateAll(elements => elements.map(row => row.getAttribute("data-session-path"))), {
					timeout: 30_000,
				})
				.toEqual([sessionPath]);
			expect(await sessionFiles(profile)).toEqual([sessionPath]);
			// Still exactly one after the page asked again: the restore ran once.
			expect((await phone.tabs()).map(tab => tab.sessionPath)).toEqual([sessionPath]);
		} finally {
			phone?.close();
			if (current) await exitApp(current).catch(() => undefined);
			await expect
				.poll(() => survivors(profile.root), { timeout: 20_000 })
				.toEqual([])
				.catch(() => undefined);
			await fs.rm(profile.root, { recursive: true, force: true }).catch(() => undefined);
		}
	});
