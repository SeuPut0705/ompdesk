import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { defaultTailscaleScenario } from "./fixture/tailscale-scenario";
import { exitApp, pressShortcutUntilVisible } from "./harness";
import { ClickProbe } from "./preview-agent-click-probe";
import {
	connectRelay,
	fixtureSite,
	lanAddress,
	type PuppeteerBrowser,
	type PuppeteerPage,
	relayEnv,
	stockRelayInstalled,
} from "./preview-agent-fixture";
import {
	connectHost,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	type RemoteInstance,
	type RemoteProfile,
} from "./remote-harness";

// Agent browsing's Preview panel on the two surfaces that are not the desktop's own window, end to end on stock's
// pieces (preview-agent.e2e.ts): the fake omp's bridge starts stock's relay server and stock's puppeteer-core drives
// the page through it.
//
// 1. A paired phone: its Preview page is an offscreen window on the computer, streamed to the phone. The robot
//    button, the banner and Take over are the phone page's own.
// 2. A paired device (another computer's OMPdesk) viewing a tab that runs on a host: the host's relay listens on the
//    host's loopback, so the device's page is driven through a tunnel over the link. The device's own native page is
//    what changes, so the device watches it live; Take over and the robot button work as on the desktop.
//
// Each: the agent drives the page (the banner names its action, the page changes), Take over (the banner goes and the
// agent's next command fails), and the robot button again (the agent drives again).

const ROBOT = /^Let the agent use this page$/;
const TAKE_OVER = /^Take over$/;
const PREVIEW_URL = /^Preview URL$/;

/** The page the agent's browser is offered: the one Preview page, nothing else. */
async function offeredPage(browser: PuppeteerBrowser): Promise<PuppeteerPage> {
	const pages = await browser.pages();
	expect(pages).toHaveLength(1);
	const [driven] = pages;
	if (!driven) throw new Error("the relay offers no page");
	return driven;
}

/** What the person sees of the page and the agent: the title, the address and the banner. */
interface AgentView {
	status: Locator;
	address: Locator;
	banner: Locator;
	robot: Locator;
	takeOver: Locator;
	/** The paired phone's page when the panel is its streamed sheet: its layout commands size the host's page. */
	phone?: Page;
}

function viewOf(panel: Locator): AgentView {
	return {
		status: panel.locator("[data-preview-status]"),
		address: panel.getByRole("textbox", { name: PREVIEW_URL }),
		banner: panel.locator("[data-preview-agent]"),
		robot: panel.getByRole("button", { name: ROBOT }),
		takeOver: panel.locator("[data-preview-agent]").getByRole("button", { name: TAKE_OVER }),
	};
}

/**
 * The agent opens the site, reads it, follows its link and the person's page follows. `pageHost` is the computer
 * whose Electron owns the page the agent drives: a click that never navigates carries the evidence of issue #21.
 */
async function agentWalks(view: AgentView, driven: PuppeteerPage, site: string, pageHost: RemoteInstance) {
	const probe = await ClickProbe.start(driven, pageHost.app, site, view.phone ?? null);
	try {
		await driven.goto(site);
		await expect(view.status).toHaveText("Agent fixture", { timeout: 30_000 });
		await expect(view.banner).toHaveAttribute("data-preview-agent", "attached");
		expect(await driven.evaluate(() => document.querySelector("h1")?.textContent)).toBe("Agent fixture");
		await probe.beforeClick();
		try {
			await Promise.all([driven.waitForNavigation(), driven.click("#next")]);
		} catch (error) {
			throw await probe.failed(error);
		}
	} finally {
		probe.stop();
	}
	await expect(view.status).toHaveText("Second page", { timeout: 30_000 });
	await expect(view.address).toHaveValue(`${site}next`);
	await expect(view.banner).toContainText(/Page\.|Runtime\.|Input\.|DOM\./);
}

/** Take over: the banner goes, the agent's connection closes and its next command fails, the page stays. */
async function takenOver(view: AgentView, browser: PuppeteerBrowser, driven: PuppeteerPage, site: string) {
	await view.takeOver.click();
	await expect(view.banner).toHaveCount(0);
	await expect.poll(() => browser.connected, { timeout: 10_000 }).toBe(false);
	await expect(driven.goto(site)).rejects.toThrow();
	await expect(view.robot).toBeVisible();
	await expect(view.status).toHaveText("Second page");
}

/** The browser the agent's tool holds, kept where the test's `finally` can close it. */
interface AgentBrowser {
	current: PuppeteerBrowser | null;
}

/**
 * The scenario on one Preview panel: the robot button lets the agent in, it drives the page (`during` may check more
 * while it holds it), Take over detaches it, and the robot button lets it in again. `pageHost` owns the page.
 */
async function driveTakeOverAndHandBack(
	view: AgentView,
	relayFile: string,
	site: string,
	agent: AgentBrowser,
	pageHost: RemoteInstance,
	during?: (driven: PuppeteerPage) => Promise<void>,
) {
	const letIn = async () => {
		await view.robot.click();
		await expect(view.banner).toHaveAttribute("data-preview-agent", "waiting");
		agent.current = await connectRelay(relayFile);
		return { browser: agent.current, driven: await offeredPage(agent.current) };
	};
	await test.step("the agent drives the page that is watched", async () => {
		const { browser, driven } = await letIn();
		await agentWalks(view, driven, site, pageHost);
		await during?.(driven);
		await test.step("Take over detaches the agent", () => takenOver(view, browser, driven, site));
	});
	await test.step("the robot button hands the page back to the agent", async () => {
		const { driven } = await letIn();
		await agentWalks(view, driven, site, pageHost);
	});
}

/** A phone's page, paired through the fake serve in front of `app`, with a tab of its own (a paired host's with `device`). */
async function pairedPhone(
	app: RemoteInstance,
	tailscale: FixtureTailscale,
	browser: Browser,
	tab: { cwd: string; device?: string },
): Promise<{ phone: Page; proxy: ServeProxy }> {
	await app.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await expect
		.poll(
			() => app.page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"),
			{
				timeout: 60_000,
			},
		)
		.toBe("ready");
	const [site] = serveSites(tailscale);
	if (!site) throw new Error("no serve handler published");
	const proxy = await ServeProxy.start(site, "seuput@example.com");
	const phone = await (await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" })).newPage();
	await phone.goto(`${proxy.url}/`);
	await phonePaired(phone);
	await phone.evaluate(spawn => window.omp.tabs.spawn({ ...spawn, kind: "agent" }), tab);
	await phone.reload();
	await phonePaired(phone);
	await expect(phone.locator("[data-composer-input]").first()).toBeVisible({ timeout: 60_000 });
	return { phone, proxy };
}

/** The phone's Preview on `address`: the tab bar under the thumb opens it, the page's frames are streamed to the sheet. */
async function phonePreview(phone: Page, address: string): Promise<AgentView> {
	await phone.locator('[data-tour="panel"]').click();
	const sheet = phone.locator("[data-sheet-panel]");
	await expect(sheet).toBeVisible();
	await phone.locator("[data-panel-tabbar]").getByRole("button", { name: "Preview", exact: true }).click();
	const view = { ...viewOf(sheet), phone };
	await view.address.fill(address);
	await view.address.press("Enter");
	await expect(view.status).toHaveText("Agent fixture", { timeout: 30_000 });
	await expect(sheet.locator("[data-preview-stream-frame]")).toBeVisible({ timeout: 30_000 });
	return view;
}

interface PairedComputers {
	host: RemoteInstance;
	client: RemoteInstance;
	hostProfile: RemoteProfile;
	/** The host as the client knows it. */
	deviceId: string;
}

/** A host and the computer paired with it (its profile on the host's port), each on the fake omp; the host's omp starts the relay. */
async function pairedComputers(
	parent: string,
	relayFile: string,
	clientEnv: Record<string, string> = {},
): Promise<PairedComputers> {
	const hostProfile = await makeRemoteProfile(parent, "host", {
		language: "en",
		theme: "light",
		env: relayEnv(relayFile),
	});
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: hostProfile.port,
		env: clientEnv,
	});
	const host = await launchRemote(hostProfile);
	const client = await launchRemote(clientProfile);
	await connectHost(host.page, client.page, "PC-B");
	await expect
		.poll(async () => (await client.page.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
			timeout: 30_000,
		})
		.toBe("online");
	const deviceId = (await client.page.evaluate(() => window.omp.remote.getState())).hosts[0]?.deviceId ?? "";
	return { host, client, hostProfile, deviceId };
}

/** A fake Tailscale on which the app serves Mobile web to a phone and sees the host at 127.0.0.1. */
async function phoneTailscale(parent: string): Promise<FixtureTailscale> {
	const dir = path.join(parent, "tailscale");
	await fs.mkdir(dir);
	const defaults = defaultTailscaleScenario();
	return fixtureTailscale(dir, {
		backendState: "Running",
		selfIps: ["127.0.0.1"],
		peers: [
			...defaults.peers,
			{ hostName: "peer", os: "macOS", online: true, userId: defaults.userId, ip: "127.0.0.1", stableId: "n-host" },
		],
	});
}

test("a paired phone's Preview page is driven by the agent through stock's relay, taken over and handed back", async () => {
	test.skip(!stockRelayInstalled(), "needs the installed omp and its puppeteer-core");
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-agent-phone-")));
	const relayFile = path.join(parent, "relay.json");
	const fixture = await fixtureSite("127.0.0.1");
	const agent: AgentBrowser = { current: null };
	const phoneBrowser = await chromium.launch();
	let app: RemoteInstance | undefined;
	let proxy: ServeProxy | undefined;
	try {
		const tailscale = await phoneTailscale(parent);
		const profile = await makeRemoteProfile(parent, "app", {
			language: "en",
			theme: "light",
			env: { ...tailscale.env, ...relayEnv(relayFile) },
		});
		app = await launchRemote(profile);
		const paired = await pairedPhone(app, tailscale, phoneBrowser, { cwd: profile.project });
		proxy = paired.proxy;
		const view = await phonePreview(paired.phone, fixture.url);
		await driveTakeOverAndHandBack(view, relayFile, fixture.url, agent, app);
	} finally {
		await agent.current?.disconnect().catch(() => {});
		await phoneBrowser.close().catch(() => {});
		await proxy?.close().catch(() => {});
		if (app) await exitApp(app.app);
		await fixture.close();
		await fs.rm(parent, { recursive: true, force: true });
	}
});

test("a paired device's own Preview page is driven by the agent of the host's tab through the link, taken over and handed back", async () => {
	test.skip(!stockRelayInstalled(), "needs the installed omp and its puppeteer-core");
	// A host's tab never loads a loopback page (the Preview's rule for a paired host's tab): the site is on this
	// computer's own address.
	const lan = lanAddress();
	test.skip(!lan, "needs a non-loopback network address");
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-agent-device-")));
	const relayFile = path.join(parent, "relay.json");
	const fixture = await fixtureSite("0.0.0.0", lan ?? "");
	const agent: AgentBrowser = { current: null };
	let computers: PairedComputers | undefined;
	try {
		computers = await pairedComputers(parent, relayFile);
		const { host, client, hostProfile, deviceId } = computers;
		await openHostFolder(client.page, deviceId, hostProfile.project);

		const aside = client.page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(client.page, "ControlOrMeta+j", aside);
		await aside.getByRole("button", { name: "Preview", exact: true }).click();
		const view = viewOf(aside);
		await view.address.fill(fixture.url);
		await view.address.press("Enter");
		await expect(view.status).toHaveText("Agent fixture", { timeout: 30_000 });

		const pageTitles = (instance: RemoteInstance) =>
			Promise.all(instance.app.windows().map(candidate => candidate.title().catch(() => "")));
		await driveTakeOverAndHandBack(view, relayFile, fixture.url, agent, client, async driven => {
			// The page that moved is the device's own native one; the host opened none.
			expect(await pageTitles(client)).toContain("Second page");
			expect(await pageTitles(host)).not.toContain("Second page");
			// This computer's own addresses are not the host agent's to open.
			await expect(driven.goto("http://localhost:1/")).rejects.toThrow(/own addresses/);
		});
	} finally {
		await agent.current?.disconnect().catch(() => {});
		if (computers) await exitApp(computers.client.app);
		if (computers) await exitApp(computers.host.app);
		await fixture.close();
		await fs.rm(parent, { recursive: true, force: true });
	}
});

test("a paired phone viewing a tab of a paired host is driven through the same tunnel", async () => {
	test.skip(!stockRelayInstalled(), "needs the installed omp and its puppeteer-core");
	const lan = lanAddress();
	test.skip(!lan, "needs a non-loopback network address");
	test.setTimeout(240_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-agent-phone-host-")));
	const relayFile = path.join(parent, "relay.json");
	const fixture = await fixtureSite("0.0.0.0", lan ?? "");
	const agent: AgentBrowser = { current: null };
	const phoneBrowser = await chromium.launch();
	let computers: PairedComputers | undefined;
	let proxy: ServeProxy | undefined;
	try {
		const tailscale = await phoneTailscale(parent);
		computers = await pairedComputers(parent, relayFile, tailscale.env);
		const { host, client, hostProfile, deviceId } = computers;
		const paired = await pairedPhone(client, tailscale, phoneBrowser, { cwd: hostProfile.project, device: deviceId });
		proxy = paired.proxy;
		const view = await phonePreview(paired.phone, fixture.url);
		await driveTakeOverAndHandBack(view, relayFile, fixture.url, agent, client, async () => {
			// The page that moved is the computer's offscreen one for the phone; the host opened none.
			expect(
				await Promise.all(host.app.windows().map(candidate => candidate.title().catch(() => ""))),
			).not.toContain("Second page");
		});
	} finally {
		await agent.current?.disconnect().catch(() => {});
		await phoneBrowser.close().catch(() => {});
		await proxy?.close().catch(() => {});
		if (computers) await exitApp(computers.client.app);
		if (computers) await exitApp(computers.host.app);
		await fixture.close();
		await fs.rm(parent, { recursive: true, force: true });
	}
});
