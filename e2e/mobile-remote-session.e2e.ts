/**
 * A paired phone opens sessions that run on another computer this one is paired with (two apps on the fake omp,
 * remote-harness.ts, plus the phone's real page in Chromium behind the fake `tailscale serve`, phone-serve.ts).
 * The chain is phone page → this computer's main (the device's WebClientWindow) → RemoteSidecar → the host's
 * LocalHostServices. The host's paths are Windows-shaped (backslashes), as on the PC that reported the hang.
 *
 * The first test walks every way a host session reaches the phone and checks the transcript shows and a prompt
 * from the phone is answered. The second holds the host's omp before it is ready: the phone must not wait forever
 * on the skeleton; the tab says which computer did not answer, the step is in this computer's runtime log, and the
 * tab comes up once the host can start it.
 *
 * `OMP_GUI_REMOTE_HOST_OUT=<built out/>` runs the host on another build (e.g. a release the PC has not updated
 * from), to check version skew between the two computers.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { defaultTailscaleScenario } from "./fixture/tailscale-scenario";
import { controlToolCaller, cssString, exitApp, openedSessions, readRecords, untilAnswered } from "./harness";
import {
	connectHost,
	freePort,
	type LinkProxy,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	type RemoteInstance,
	type RemoteProfile,
} from "./remote-harness";

/** The page goes to the background (`visibilitychange`), as a locked phone's does. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
	await page.evaluate(hide => {
		if (hide) {
			Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
			Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
		} else {
			Reflect.deleteProperty(document, "visibilityState");
			Reflect.deleteProperty(document, "hidden");
		}
		document.dispatchEvent(new Event("visibilitychange"));
	}, hidden);
}

/**
 * A stored session on `agentDir`'s machine, typed there: the prompt, `calls` shell calls each answered with
 * `outputChars` of output, then the answer.
 */
async function seedSession(
	agentDir: string,
	project: string,
	name: string,
	prompt: string,
	bulk: { calls: number; outputChars: number } = { calls: 0, outputChars: 0 },
): Promise<string> {
	const dir = path.join(agentDir, "sessions", "fixture");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	const at = Date.now() - 60_000;
	const lines: unknown[] = [
		{ type: "session", version: 3, id: name, timestamp: new Date(at).toISOString(), cwd: project },
	];
	let parentId: string | null = null;
	let n = 0;
	const push = (message: Record<string, unknown>) => {
		const id = `${name}-${++n}`;
		lines.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(at + n).toISOString(),
			message: { ...message, timestamp: at + n },
		});
		parentId = id;
	};
	const assistant = { provider: "fixture", model: "local-fixture" };
	push({ role: "user", content: [{ type: "text", text: prompt }] });
	const output = Array.from({ length: Math.ceil(bulk.outputChars / 32) }, () =>
		Math.random().toString(36).slice(2, 10).padEnd(8, "0").repeat(4),
	)
		.join("")
		.slice(0, bulk.outputChars);
	for (let call = 0; call < bulk.calls; call++) {
		const toolCallId = `${name}-call-${call}`;
		push({
			role: "assistant",
			...assistant,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: `echo ${call}` } }],
		});
		push({
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: output }],
		});
	}
	push({
		role: "assistant",
		...assistant,
		stopReason: "stop",
		content: [{ type: "text", text: `Answer to ${prompt}` }],
	});
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

async function openDrawer(phone: Page): Promise<void> {
	await phone.getByRole("button", { name: "Open menu" }).click();
	const sidebar = phone.locator("[data-drawer] .omp-session-sidebar");
	await expect(sidebar).toBeVisible();
}

async function sendFromPhone(phone: Page, text: string): Promise<void> {
	await phone.locator("[data-composer-input]").first().fill(text);
	// A phone's Enter is a newline: the Send button sends.
	await phone.getByRole("button", { name: /^(Send|보내기)$/ }).click();
}

async function hostOnline(client: RemoteInstance): Promise<void> {
	await expect
		.poll(async () => (await client.page.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
			timeout: 60_000,
		})
		.toBe("online");
}

async function mobileWebReady(client: RemoteInstance): Promise<void> {
	await expect
		.poll(
			() => client.page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"),
			{ timeout: 60_000 },
		)
		.toBe("ready");
}

interface Rig {
	parent: string;
	hostProfile: RemoteProfile;
	clientProfile: RemoteProfile;
	/** The host's agent dir: Windows-shaped (`…/C:\Users\admin\.omp\agent` on POSIX; Windows paths are that already). */
	hostAgent: string;
	host: RemoteInstance | undefined;
	client: RemoteInstance | undefined;
	deviceId: string;
	phone: Page;
	tailscale: FixtureTailscale;
	proxy: ServeProxy;
	link: LinkProxy;
	browser: Browser;
	phoneErrors: string[];
	launchHost(options?: { project?: boolean; ready?: boolean }): Promise<RemoteInstance>;
}

/**
 * Host (fixed port, reached through a `linkProxy` so the link can be cut), this computer paired with it and serving
 * the phone page, and the phone's page loaded. `seed` stores sessions before the apps start.
 */
async function rig(
	options: { hostEnv?: Record<string, string>; clientEnv?: Record<string, string>; hostReady?: boolean },
	seed: (hostAgent: string, hostProfile: RemoteProfile, clientProfile: RemoteProfile) => Promise<void>,
): Promise<Rig> {
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-phone-remote-")));
	const tailscaleDir = path.join(parent, "tailscale");
	await fs.mkdir(tailscaleDir);
	// This computer's Tailscale: the phone's node (Mobile web) and the host at 127.0.0.1 (computer sharing).
	const defaults = defaultTailscaleScenario();
	const tailscale = await fixtureTailscale(tailscaleDir, {
		backendState: "Running",
		selfIps: ["127.0.0.1"],
		peers: [
			...defaults.peers,
			{ hostName: "peer", os: "macOS", online: true, userId: defaults.userId, ip: "127.0.0.1", stableId: "n-host" },
		],
	});
	const hostPort = await freePort();
	// POSIX plays a Windows host with one folder named like its agent dir. A drive letter cannot name a folder on Windows.
	const hostAgent =
		process.platform === "win32"
			? path.join(parent, "host-home", ".omp", "agent")
			: path.join(parent, "host-home", "C:\\Users\\admin\\.omp\\agent");
	await fs.mkdir(hostAgent, { recursive: true });
	const hostProfile = await makeRemoteProfile(parent, "host", {
		language: "en",
		theme: "light",
		port: hostPort,
		env: { PI_CODING_AGENT_DIR: hostAgent, ...options.hostEnv },
	});
	const link = await linkProxy(hostPort);
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: Number(link.address.split(":")[1]),
		env: { ...tailscale.env, ...options.clientEnv },
	});
	await seed(hostAgent, hostProfile, clientProfile);
	const launchHost = async (launch: { project?: boolean; ready?: boolean } = {}) => {
		const own = process.env.OMP_GUI_E2E_OUT;
		if (process.env.OMP_GUI_REMOTE_HOST_OUT) process.env.OMP_GUI_E2E_OUT = process.env.OMP_GUI_REMOTE_HOST_OUT;
		try {
			return await launchRemote(hostProfile, launch);
		} finally {
			// Assigning undefined would set the string "undefined" (process.env stringifies), so the client
			// would launch from ./undefined: an unset value is deleted again.
			if (own === undefined) Reflect.deleteProperty(process.env, "OMP_GUI_E2E_OUT");
			else process.env.OMP_GUI_E2E_OUT = own;
		}
	};
	const host = await launchHost({ ready: options.hostReady !== false });
	const client = await launchRemote(clientProfile);
	const deviceId = await connectHost(host.page, client.page, "PC-B");
	await hostOnline(client);
	await client.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await mobileWebReady(client);
	const [site] = serveSites(tailscale);
	if (!site) throw new Error("no serve handler published");
	const proxy = await ServeProxy.start(site, "seuput@example.com");
	const browser = await chromium.launch();
	const phone = await (await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" })).newPage();
	const phoneErrors: string[] = [];
	// The stack, not only the message: a call the dropped link failed reads "The link to the computer dropped" whoever
	// made it, and under load three of them once failed the relaunch step with nothing naming their callers.
	phone.on("pageerror", error => phoneErrors.push(error.stack ?? error.message));
	await phone.goto(`${proxy.url}/`);
	await phonePaired(phone);
	return {
		parent,
		hostProfile,
		clientProfile,
		hostAgent,
		host,
		client,
		deviceId,
		phone,
		tailscale,
		proxy,
		link,
		browser,
		phoneErrors,
		launchHost,
	};
}

async function teardown(setup: Rig | undefined): Promise<void> {
	if (!setup) return;
	await setup.browser.close().catch(() => undefined);
	await setup.proxy.close().catch(() => undefined);
	await setup.link.close().catch(() => undefined);
	if (setup.client) await exitApp(setup.client.app);
	if (setup.host) await exitApp(setup.host.app);
	await fs.rm(setup.parent, { recursive: true, force: true }).catch(() => undefined);
}

/** The host's session row in the phone's drawer. */
async function hostRow(setup: Rig, sessionPath: string) {
	await openDrawer(setup.phone);
	const section = setup.phone.locator(`[data-drawer] [data-sidebar-device="${setup.deviceId}"]`);
	await expect(section).toHaveAttribute("data-device-state", "online", { timeout: 30_000 });
	const row = section.locator(`[data-device-session=${cssString(sessionPath)}] button[data-roving-item]`);
	await expect(row).toBeVisible({ timeout: 30_000 });
	return row;
}

test("a paired phone opens and works in sessions of a remote host this computer is paired with", async () => {
	test.setTimeout(240_000);
	const sessions = { stored: "", macHeld: "", hostHeld: "", hostAsleep: "", local: "" };
	let setup: Rig | undefined;
	try {
		setup = await rig({}, async (hostAgent, hostProfile, clientProfile) => {
			sessions.stored = await seedSession(hostAgent, hostProfile.project, "remote-stored", "Stored on the host", {
				calls: 40,
				outputChars: 100_000,
			});
			sessions.macHeld = await seedSession(
				hostAgent,
				hostProfile.project,
				"remote-mac-held",
				"Open on this computer",
			);
			sessions.hostHeld = await seedSession(hostAgent, hostProfile.project, "remote-host-held", "Open on the host");
			sessions.hostAsleep = await seedSession(hostAgent, hostProfile.project, "remote-asleep", "Asleep on the host");
			sessions.local = await seedSession(
				path.join(clientProfile.root, "agent"),
				clientProfile.project,
				"local-session",
				"Typed on this computer",
			);
		});
		const { phone, deviceId, hostProfile, clientProfile } = setup;
		const client = setup.client as RemoteInstance;
		const host = setup.host as RemoteInstance;
		// This computer's desktop window has one of the host's sessions open, the host's own window another.
		await client.page.evaluate(args => window.omp.tabs.spawn({ sessionPath: args.path, device: args.device }), {
			path: sessions.macHeld,
			device: deviceId,
		});
		await host.page.evaluate(p => window.omp.tabs.spawn({ sessionPath: p }), sessions.hostHeld);
		for (const [page, sessionPath] of [
			[client.page, sessions.macHeld],
			[host.page, sessions.hostHeld],
		] as const)
			await expect
				.poll(
					async () =>
						(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.sessionPath === sessionPath)
							?.status,
					{ timeout: 60_000 },
				)
				.toBe("ready");

		/** Open the host's session from the drawer: its transcript shows and a prompt from the phone is answered. */
		const openRemote = async (sessionPath: string, prompt: string) => {
			await (await hostRow(setup as Rig, sessionPath)).click();
			await expect(phone.getByText(`Answer to ${prompt}`)).toBeVisible({ timeout: 30_000 });
			await sendFromPhone(phone, `Phone follows up on ${prompt}`);
			await expect(phone.getByText(`Phone follows up on ${prompt}`)).toBeVisible({ timeout: 30_000 });
			await expect(
				phone.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" }).first(),
			).toBeVisible({ timeout: 30_000 });
			const tabs = await phone.evaluate(() => window.omp.tabs.list());
			expect(tabs.find(tab => tab.sessionPath === sessionPath)).toMatchObject({ device: deviceId, status: "ready" });
		};

		await test.step("a stored session of the host, with a large transcript", () =>
			openRemote(sessions.stored, "Stored on the host"));

		await test.step("the link to the host drops while the phone is away, and comes back", async () => {
			const status = () =>
				phone.evaluate(
					p => window.omp.tabs.list().then(tabs => tabs.find(tab => tab.sessionPath === p)?.status),
					sessions.stored,
				);
			await setHidden(phone, true);
			await setup?.link.drop();
			await expect.poll(status, { timeout: 60_000 }).not.toBe("ready");
			await setup?.link.restore();
			await hostOnline(client);
			await setHidden(phone, false);
			await expect.poll(status, { timeout: 60_000 }).toBe("ready");
			await expect(phone.getByText("Answer to Stored on the host")).toBeVisible({ timeout: 30_000 });
			await sendFromPhone(phone, "Phone after the link came back");
			await expect(phone.getByText("Phone after the link came back")).toBeVisible({ timeout: 30_000 });
		});

		await test.step("a session the phone's own agent opened on the host", async () => {
			const spawned = await phone.evaluate(
				cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }),
				clientProfile.project,
			);
			const opener = spawned?.tabId ?? "";
			expect(opener).not.toBe("");
			await expect
				.poll(
					async () =>
						(await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === opener)?.status,
					{ timeout: 30_000 },
				)
				.toBe("ready");
			const call = await controlToolCaller(phone, clientProfile.record, opener);
			const open = await call("ompdesk_session_open", {
				device: "PC-B",
				folder: hostProfile.project,
				message: "Title: Check on the PC\nRun this on the other computer",
				show: "background",
			});
			expect(open.isError, open.text).toBe(false);
			const [child] = openedSessions(open.text);
			// The brief's reply in the transcript, not the last answer (`untilAnswered`, harness.ts).
			await untilAnswered(phone, child as string);
			const done = await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
			expect(done.text).toContain(`[${child}]: idle`);
			const childPath =
				(await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.openedBy === opener)?.sessionPath ??
				"";
			expect(childPath).not.toBe("");
			// It is the opener's child (one family across computers), never a row of PC-B's own list; finished, it is not
			// listed at all, as a local child is not. The opener's agent shows it.
			await openDrawer(phone);
			await expect(phone.locator(`[data-drawer] [data-device-session=${cssString(childPath)}]`)).toHaveCount(0);
			expect((await call("ompdesk_tab_focus", { session: child })).isError).toBe(false);
			await expect(phone.getByText("Run this on the other computer").first()).toBeVisible({ timeout: 30_000 });
			await expect(phone.getByText("Local fixture reply").first()).toBeVisible({ timeout: 30_000 });
		});

		await test.step("a host session this computer's desktop window has open", () =>
			openRemote(sessions.macHeld, "Open on this computer"));
		await test.step("a host session the host's own window has open", () =>
			openRemote(sessions.hostHeld, "Open on the host"));

		await test.step("a host session the relaunched host holds as a tab not started yet", async () => {
			await host.page.evaluate(p => window.omp.tabs.spawn({ sessionPath: p }), sessions.hostAsleep);
			// Another tab is the active one, so the relaunch leaves the session's tab asleep.
			await host.page.evaluate(cwd => window.omp.tabs.spawn({ cwd }), hostProfile.project);
			await expect
				.poll(() => fs.readFile(path.join(hostProfile.desktop, "prefs.json"), "utf8"), {
					timeout: 10_000,
				})
				.toContain("remote-asleep");
			await exitApp(host.app);
			setup = { ...(setup as Rig), host: undefined };
			const relaunched = await (setup as Rig).launchHost({ project: false });
			setup = { ...(setup as Rig), host: relaunched };
			await expect
				.poll(
					async () =>
						(await relaunched.page.evaluate(() => window.omp.tabs.list())).find(
							tab => tab.sessionPath === sessions.hostAsleep,
						)?.status,
					{ timeout: 30_000 },
				)
				.toBe("asleep");
			await hostOnline(client);
			await openRemote(sessions.hostAsleep, "Asleep on the host");
		});

		await test.step("a session of this computer still opens on the phone", async () => {
			await openDrawer(phone);
			const sidebar = phone.locator("[data-drawer] .omp-session-sidebar");
			for (const fold of await sidebar.locator('[data-workspace-group] button[aria-expanded="false"]').all())
				await fold.click().catch(() => undefined);
			const row = sidebar.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessions.local)}]`);
			await expect(row).toBeVisible({ timeout: 30_000 });
			await row.click();
			await expect(phone.getByText("Answer to Typed on this computer")).toBeVisible({ timeout: 30_000 });
		});

		await test.step("after this computer relaunches, the phone's restored host tabs open", async () => {
			await exitApp(client.app);
			setup = { ...(setup as Rig), client: undefined };
			const relaunched = await launchRemote(clientProfile, { project: false });
			setup = { ...(setup as Rig), client: relaunched };
			await hostOnline(relaunched);
			await mobileWebReady(relaunched);
			const [next] = serveSites((setup as Rig).tailscale);
			if (!next) throw new Error("no serve handler published after the relaunch");
			(setup as Rig).proxy.retarget(next);
			await phone.reload();
			await expect(phone.getByRole("button", { name: "Open menu" })).toBeVisible({ timeout: 60_000 });
			for (const [sessionPath, prompt] of [
				[sessions.stored, "Stored on the host"],
				[sessions.hostHeld, "Open on the host"],
			] as const) {
				await (await hostRow(setup as Rig, sessionPath)).click();
				await expect(phone.getByText(`Answer to ${prompt}`)).toBeVisible({ timeout: 30_000 });
				await sendFromPhone(phone, `Phone after relaunch on ${prompt}`);
				await expect(phone.getByText(`Phone after relaunch on ${prompt}`)).toBeVisible({ timeout: 30_000 });
			}
		});
		expect(setup.phoneErrors).toEqual([]);
	} finally {
		await teardown(setup);
	}
});

test("a host that never starts the session is named on the phone, logged, and the tab comes up once it can", async () => {
	test.setTimeout(180_000);
	let stored = "";
	let setup: Rig | undefined;
	try {
		setup = await rig(
			{
				// The host's omp never reports ready (a hung start on the PC).
				hostEnv: { OMP_GUI_TEST_BOOT_DELAY_MS: "600000" },
				hostReady: false,
				clientEnv: { OMP_GUI_REMOTE_START_TIMEOUT_MS: "4000" },
			},
			async (hostAgent, hostProfile) => {
				stored = await seedSession(hostAgent, hostProfile.project, "remote-stuck", "Stuck on the host");
			},
		);
		const { phone, clientProfile, hostProfile } = setup;
		await (await hostRow(setup, stored)).click();

		await test.step("the phone names the computer that did not start it, with Restart", async () => {
			const banner = phone.getByRole("alert").filter({ hasText: "PC-B" });
			await expect(banner).toBeVisible({ timeout: 30_000 });
			await expect(banner.getByRole("button", { name: "Restart" })).toBeVisible();
			const tab = (await phone.evaluate(() => window.omp.tabs.list())).find(entry => entry.sessionPath === stored);
			expect(tab?.status).toBe("error");
		});

		await test.step("this computer's runtime log says which step never answered", async () => {
			const log = path.join(clientProfile.desktop, "logs", "gui-runtime.jsonl");
			await expect
				.poll(async () =>
					(await readRecords(log).catch(() => []))
						.filter(line => line.source === "remote-tab")
						.map(line => `${line.message} ${(line.details as { step?: string } | undefined)?.step ?? ""}`.trim()),
				)
				.toEqual(expect.arrayContaining(["open", "start", "stalled ready"]));
		});

		await test.step("Restart keeps the session it was opening: once the host can start, that session comes up", async () => {
			// Pressed while the host is still stuck, Restart must try the same session again (it stalls again), never a
			// new one: the banner's Restart sends no session file, and a remote tab once forgot the one it was opening,
			// so the host later started an empty session.
			const restart = phone.getByRole("alert").filter({ hasText: "PC-B" }).getByRole("button", { name: "Restart" });
			await restart.click();
			await expect(restart).toBeHidden();
			await expect(restart).toBeVisible({ timeout: 30_000 });
			const host = setup?.host;
			if (host) await exitApp(host.app);
			Reflect.deleteProperty(hostProfile.env, "OMP_GUI_TEST_BOOT_DELAY_MS");
			setup = { ...(setup as Rig), host: await (setup as Rig).launchHost() };
			await hostOnline((setup as Rig).client as RemoteInstance);
			// The link coming back brings the tab up by itself: no Restart to race against.
			await expect(phone.getByText("Answer to Stuck on the host")).toBeVisible({ timeout: 60_000 });
		});
	} finally {
		await teardown(setup);
	}
});

test("the phone's work strip shows a host session's running turn, its todos and its subagents", async () => {
	test.setTimeout(180_000);
	let stored = "";
	let setup: Rig | undefined;
	try {
		setup = await rig({}, async (hostAgent, hostProfile) => {
			stored = await seedSession(hostAgent, hostProfile.project, "remote-working", "Working on the host");
		});
		const { phone } = setup;
		await (await hostRow(setup, stored)).click();
		await expect(phone.getByText("Answer to Working on the host")).toBeVisible({ timeout: 30_000 });
		const tabId = (await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.sessionPath === stored)?.tabId;
		if (!tabId) throw new Error("no host tab");
		const strip = phone.locator("[data-work-strip] [data-work-chip]");
		await sendFromPhone(phone, "fixture steer work");
		await expect(strip).toBeVisible({ timeout: 20_000 });
		for (const command of ["fixture:todo", "fixture:subagents"])
			await phone.evaluate(([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }), [
				tabId,
				command,
			] as const);
		await expect(strip).toContainText("0/6", { timeout: 20_000 });
		await expect(strip.locator('[data-count="agents"]')).toBeVisible();
		expect(setup.phoneErrors).toEqual([]);
	} finally {
		await teardown(setup);
	}
});
