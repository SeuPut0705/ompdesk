/**
 * The bot's conversation renews (src/main/agent-control/bot-rotation.ts): New conversation on the bot's bar starts a
 * fresh session in the bot's place, seeded with the outgoing conversation's handoff note (the fake omp answers the side
 * question `btw` with "Local side answer"); the old conversation is listed under the bot read-only. The same seen from
 * a paired computer's section for the host and on the phone's page (390 px). The triggers, quiet moments and ages are
 * unit-tested in bot-rotation.test.ts and host.test.ts. `OMPDESK_BOT_SHOTS=<dir>` keeps the screenshots.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { captureTo, cssString, exitApp, fixtureOmp, launchApp } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

const SHOTS = process.env.OMPDESK_BOT_SHOTS;
const HANDOFF = "Local side answer";
const HANDOFF_CARD = /Handoff from your previous conversation/;

/** The bar's actions (New conversation, the identity pencil, call, pause) sit inside it, side by side, none over another. */
async function expectBarFits(page: Page): Promise<void> {
	const bar = await page.locator("[data-bot-bar]").first().boundingBox();
	if (!bar) throw new Error("no bot bar");
	const selectors = [
		"[data-bot-new-conversation]",
		"[data-bot-identity-edit]",
		"[data-bot-call-start]",
		"[data-bot-pause]",
	];
	const boxes = await Promise.all(
		selectors.map(async selector => {
			const box = await page.locator(`[data-bot-bar] ${selector}`).first().boundingBox();
			if (!box) throw new Error(`${selector} is not on the bar`);
			return box;
		}),
	);
	for (const box of boxes) {
		expect(box.x).toBeGreaterThanOrEqual(bar.x - 0.5);
		expect(box.x + box.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
	}
	// The name keeps room for a few letters however narrow the pane (the wake text and the computer give way first).
	expect((await page.locator("[data-bot-bar] [data-bot-name]").first().boundingBox())?.width ?? 0).toBeGreaterThan(16);
	for (let index = 1; index < boxes.length; index += 1) {
		const left = boxes[index - 1];
		const right = boxes[index];
		if (left && right) expect(right.x + 0.5).toBeGreaterThanOrEqual(left.x + left.width);
	}
}

/** The handoff note the new conversation starts from: its card in the transcript, opened to show the note. */
async function expectHandoff(page: Page, timeout = 60_000): Promise<void> {
	const card = page.getByRole("button", { name: HANDOFF_CARD }).first();
	await expect(card).toBeVisible({ timeout });
	await card.click();
	await expect(page.getByText(HANDOFF).first()).toBeVisible({ timeout: 10_000 });
}

async function prefPath(page: Page, key: string): Promise<string> {
	const value = await page.evaluate(name => window.omp.prefs.get(name), key);
	return typeof value === "string" ? value : "";
}

/** Opens the bot from the sidebar's row and answers its tab once its omp is ready. */
async function openBot(page: Page, botPath: string): Promise<string> {
	await page.locator("[data-sidebar-bot-row]").first().click();
	let tabId = "";
	await expect
		.poll(
			async () => {
				const tab = (await page.evaluate(() => window.omp.tabs.list())).find(
					entry => entry.sessionPath === botPath,
				);
				tabId = tab?.tabId ?? "";
				return tab?.status;
			},
			{ timeout: 60_000 },
		)
		.toBe("ready");
	return tabId;
}

/** The bot's pref names a new file: the conversation renewed. */
async function renewedFrom(page: Page, before: string): Promise<string> {
	let next = "";
	await expect
		.poll(
			async () => {
				next = await prefPath(page, "bot");
				return next !== "" && next !== before;
			},
			{ timeout: 60_000 },
		)
		.toBe(true);
	return next;
}

test("New conversation starts a fresh bot conversation from the handoff, and keeps the old one read-only", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-rotation-"));
	const dirs = {
		project: path.join(profile, "project"),
		desktop: path.join(profile, "desktop"),
		agent: path.join(profile, "agent"),
	};
	await Promise.all(Object.values(dirs).map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(dirs.desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, botEnabled: true }),
	);
	const errors: string[] = [];
	let app: ElectronApplication | null = null;
	try {
		app = await launchApp({ ...dirs, profile, env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_SESSION_FILES: "1" } });
		const page = await app.firstWindow();
		page.on("pageerror", error => errors.push(error.message));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect.poll(() => prefPath(page, "bot"), { timeout: 30_000 }).not.toBe("");
		const first = await prefPath(page, "bot");
		const tabId = await openBot(page, first);

		await page.locator("[data-bot-new-conversation]").click();
		const second = await renewedFrom(page, first);
		// The same tab now holds the new conversation, under the bot's bar, and shows the handoff it starts from.
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.sessionPath,
			)
			.toBe(second);
		await expect(page.locator("[data-bot-bar]")).toBeVisible();
		await expectHandoff(page);
		await expect(page.locator("[data-composer-input]").first()).toBeEditable();
		const rows = await page.evaluate(() => window.omp.sessions.list("global"));
		expect(rows.find(row => row.path === second)?.bot).toBe("on");
		expect(rows.find(row => row.path === first)?.bot).toBe("past");
		await expectBarFits(page);
		await captureTo(SHOTS, page, "bot-rotation-desktop");

		// The old conversation is listed under the bot and opens read-only: a note where the composer was.
		const past = page.locator(`[data-bot-past-open=${cssString(first)}]`);
		await expect(past).toBeVisible({ timeout: 30_000 });
		await past.click();
		await expect(page.locator("[data-bot-ended-note]")).toBeVisible({ timeout: 60_000 });
		await expect(page.locator("[data-composer-input]")).toHaveCount(0);
		let pastTab = "";
		await expect
			.poll(
				async () => {
					const tab = (await page.evaluate(() => window.omp.tabs.list())).find(
						entry => entry.sessionPath === first,
					);
					pastTab = tab?.tabId ?? "";
					return tab?.status;
				},
				{ timeout: 60_000 },
			)
			.toBe("ready");
		const refused = await page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "continue" }),
			pastTab,
		);
		expect(refused).toMatchObject({ success: false, code: "bot_conversation_ended" });
		await captureTo(SHOTS, page, "bot-rotation-past");
		await page.locator("[data-bot-ended-open-current]").click();
		await expect(page.locator("[data-composer-input]").first()).toBeEditable({ timeout: 30_000 });
	} finally {
		if (app) await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
	expect(errors).toEqual([]);
});

test("a paired computer's bot row follows the host's renewal, and opens the fresh conversation", async () => {
	test.setTimeout(300_000);
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-rotation-device-"));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	try {
		const hostProfile = await makeRemoteProfile(parent, "host", {
			language: "en",
			theme: "light",
			prefs: { botEnabled: true },
		});
		const clientProfile = await makeRemoteProfile(parent, "client", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const deviceId = await connectHost(host.page, client.page, "PC-B");
		const hostPage = host.page;
		const clientPage = client.page;
		await expect
			.poll(async () => (await clientPage.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
				timeout: 30_000,
			})
			.toBe("online");
		await expect.poll(() => prefPath(hostPage, "bot"), { timeout: 30_000 }).not.toBe("");
		const first = await prefPath(hostPage, "bot");
		await openBot(hostPage, first);
		const section = clientPage.locator(`[data-sidebar-device=${cssString(deviceId)}]`);
		await expect(section.locator(`[data-device-session=${cssString(first)}]`)).toHaveCount(1, { timeout: 30_000 });

		// The device asks for it from the host's bot pane: the host renews its own bot.
		await section.locator("[data-sidebar-bot-row]").click();
		await expect(clientPage.locator("[data-bot-new-conversation]")).toBeVisible({ timeout: 60_000 });
		await clientPage.locator("[data-bot-new-conversation]").click();
		const second = await renewedFrom(hostPage, first);
		await expectHandoff(hostPage);

		// The device's row for the host's bot is the new conversation; the old one is no row of the lists.
		await expect(section.locator(`[data-device-session=${cssString(second)}]`)).toHaveCount(1, { timeout: 30_000 });
		await expect(section.locator(`[data-device-session=${cssString(first)}]`)).toHaveCount(0);
		await section.locator("[data-sidebar-bot-row]").click();
		await expect(clientPage.locator("[data-bot-bar]")).toBeVisible({ timeout: 60_000 });
		await expectHandoff(clientPage);
		await expectBarFits(clientPage);
		await captureTo(SHOTS, clientPage, "bot-rotation-device");
	} finally {
		for (const instance of [client, host]) if (instance) await exitApp(instance.app);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
	for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
});

test("the phone's page (390 px) renews the bot and shows the fresh conversation with its handoff", async () => {
	test.setTimeout(240_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-mobile-bot-rotation-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			themeName: "light",
			firstRunComplete: true,
			lastProject: project,
			botEnabled: true,
		}),
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
	let app: ElectronApplication | null = null;
	let proxy: ServeProxy | null = null;
	const browser = await chromium.launch();
	try {
		app = await electron.launch({
			args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
			env,
		});
		const desk = await app.firstWindow();
		await desk.waitForFunction(() => window.omp?.rpc != null);
		await expect.poll(() => prefPath(desk, "bot"), { timeout: 30_000 }).not.toBe("");
		const first = await prefPath(desk, "bot");
		await openBot(desk, first);
		const botCwd = (await desk.evaluate(() => window.omp.tabs.list())).find(tab => tab.sessionPath === first)?.cwd;

		await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(tailscale).at(-1);
		if (!site) throw new Error("serve publishes no handler");
		proxy = await ServeProxy.start(site, "seuput@example.com");

		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			deviceScaleFactor: 3,
			isMobile: true,
			hasTouch: true,
		});
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);
		const viewed = await phone.evaluate(
			([cwd, sessionPath]) => window.omp.tabs.spawn({ cwd: cwd ?? "", kind: "chat", sessionPath }),
			[botCwd, first] as const,
		);
		if (!viewed?.tabId) throw new Error(`the phone could not view the bot: ${JSON.stringify(viewed)}`);
		await phone.goto(`${proxy.url}/#/open?tab=${viewed.tabId}`);
		await expect(phone.locator("[data-bot-new-conversation]")).toBeVisible({ timeout: 60_000 });
		await phone.locator("[data-bot-new-conversation]").tap();
		const second = await renewedFrom(desk, first);
		// The phone views the window's bot tab, which moved onto the new conversation: the handoff shows there.
		await expectHandoff(phone);
		await expect(phone.locator("[data-bot-bar]")).toBeVisible();
		expect(second).not.toBe(first);
		await expectBarFits(phone);
		await captureTo(SHOTS, phone, "bot-rotation-phone-390");
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		if (app) await exitApp(app).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});
