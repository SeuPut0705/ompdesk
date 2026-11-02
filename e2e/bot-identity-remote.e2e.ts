/**
 * Who a paired host's bot is, edited from everywhere it shows (BotIdentitySettings.tsx: the bar's sheet, Settings ›
 * Bot's section for that host): on the host itself, on the paired computer and on the phone's page (390 px) that
 * computer serves. Each edit lands in the host's desk or its bot's session title, and every surface shows it without a
 * reload: the host's own sidebar row and bar, the paired computer's device section and bar, the phone's drawer and bar.
 *
 * `OMPDESK_BOT_IDENTITY_SHOTS=<dir>` also keeps the screenshots there.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { defaultTailscaleScenario } from "./fixture/tailscale-scenario";
import { cssString, exitApp, pressShortcutUntilVisible, untilAnswered } from "./harness";
import { connectHost, freePort, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

let parent: string;
let host: RemoteInstance | undefined;
let client: RemoteInstance | undefined;
let browser: Browser | undefined;
let proxy: ServeProxy | undefined;
let phoneErrors: string[] = [];

test.afterEach(async () => {
	await browser?.close().catch(() => undefined);
	await proxy?.close().catch(() => undefined);
	for (const instance of [client, host]) if (instance) await exitApp(instance.app);
	for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
	expect(phoneErrors).toEqual([]);
	await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function capture(page: Page, name: string): Promise<void> {
	const body = await page.screenshot({ animations: "disabled" });
	await test.info().attach(name, { body, contentType: "image/png" });
	const dir = process.env.OMPDESK_BOT_IDENTITY_SHOTS;
	if (dir) {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, `${name}.png`), body);
	}
}

interface HostDesk {
	identity?: { avatar?: { kind: string; shape?: string }; tagline?: string; persona?: string };
}

/** Fill a field that saves when it loses focus, as the owner would. */
async function commitField(field: Locator, value: string): Promise<void> {
	await field.fill(value);
	await field.blur();
}

test("a host's bot is renamed and restyled from the host, a paired computer and the phone, and every surface follows", async () => {
	test.setTimeout(300_000);
	parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-remote-id-")));
	// The paired computer's Tailscale: the phone's node (Mobile web) and the host at 127.0.0.1 (computer sharing).
	const tailscaleDir = path.join(parent, "tailscale");
	await fs.mkdir(tailscaleDir);
	const defaults = defaultTailscaleScenario();
	const tailscale = await fixtureTailscale(tailscaleDir, {
		backendState: "Running",
		selfIps: ["127.0.0.1"],
		peers: [
			...defaults.peers,
			{ hostName: "peer", os: "macOS", online: true, userId: defaults.userId, ip: "127.0.0.1", stableId: "n-host" },
		],
	});
	const hostProfile = await makeRemoteProfile(parent, "host", {
		language: "en",
		theme: "light",
		port: await freePort(),
		prefs: { botEnabled: true },
	});
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: hostProfile.port,
		env: tailscale.env,
	});
	host = await launchRemote(hostProfile);
	client = await launchRemote(clientProfile);
	const hostPage = host.page;
	const clientPage = client.page;
	const deviceId = await connectHost(hostPage, clientPage, "PC-B");
	await expect
		.poll(async () => (await clientPage.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
			timeout: 60_000,
		})
		.toBe("online");
	let botPath = "";
	await expect
		.poll(
			async () => {
				const value = await hostPage.evaluate(() => window.omp.prefs.get("bot"));
				botPath = typeof value === "string" ? value : "";
				return botPath;
			},
			{ timeout: 30_000 },
		)
		.not.toBe("");
	const hostDesk = async (): Promise<HostDesk> => {
		try {
			return JSON.parse(await fs.readFile(path.join(hostProfile.desktop, "bot-desk.json"), "utf8")) as HostDesk;
		} catch {
			return {};
		}
	};
	const hostTitle = async () =>
		(await hostPage.evaluate(() => window.omp.sessions.list("global"))).find(row => row.path === botPath)?.title;

	// 1. On the host itself: its bar opens who the bot is in a sheet.
	await hostPage.locator("[data-sidebar-bot-row]").click();
	const hostBar = hostPage.locator("[data-bot-bar]");
	await expect(hostBar).toBeVisible({ timeout: 60_000 });
	// The bot has talked once, so its session is written: stock (and the fake omp) keep a rename in memory until then.
	const botTab = (await hostPage.evaluate(() => window.omp.tabs.list())).find(
		tab => tab.sessionPath === botPath,
	)?.tabId;
	if (!botTab) throw new Error("the host's bot has no tab");
	await expect
		.poll(
			async () => (await hostPage.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === botTab)?.status,
			{
				timeout: 60_000,
			},
		)
		.toBe("ready");
	await hostPage.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "Hello" }), botTab);
	await untilAnswered(hostPage, botTab);
	await hostBar.locator("[data-bot-identity-edit]").click();
	const hostSheet = hostPage.locator("[data-bot-identity-sheet='local']");
	await expect(hostSheet).toBeVisible();
	await commitField(hostSheet.locator("[data-bot-tagline-field]"), "Keeps CI green");
	await expect.poll(async () => (await hostDesk()).identity?.tagline).toBe("Keeps CI green");
	await capture(hostPage, "host-sheet");
	await hostPage.keyboard.press("Escape");
	await expect(hostSheet).toHaveCount(0);
	await expect(hostBar.locator("[data-bot-tagline]")).toHaveText("Keeps CI green");

	// 2. On the paired computer: the device section's bot row opens the host's bot, whose bar edits it on the host.
	const section = clientPage.locator(`[data-sidebar-device=${cssString(deviceId)}]`);
	const deviceRow = section.locator("[data-sidebar-bot-row]");
	await expect(deviceRow).toHaveCount(1, { timeout: 30_000 });
	await deviceRow.click();
	const clientBar = clientPage.locator("[data-bot-bar]");
	await expect(clientBar.locator("[data-bot-device]")).toContainText("PC-B", { timeout: 60_000 });
	await expect(clientBar.locator("[data-bot-tagline]")).toHaveText("Keeps CI green");
	await clientBar.locator("[data-bot-identity-edit]").click();
	const clientSheet = clientPage.locator(`[data-bot-identity-sheet=${cssString(deviceId)}]`);
	await expect(clientSheet).toBeVisible();
	await commitField(clientSheet.locator("[data-bot-name-field]"), "Nova");
	await clientSheet.locator('[data-bot-avatar-shape="rocket"]').click();
	await commitField(clientSheet.locator("[data-bot-persona-field]"), "Short and calm.");
	await expect.poll(hostTitle, { timeout: 30_000 }).toBe("Nova");
	await expect
		.poll(async () => {
			const identity = (await hostDesk()).identity;
			return [identity?.avatar?.shape, identity?.persona];
		})
		.toEqual(["rocket", "Short and calm."]);
	await capture(clientPage, "device-sheet");
	await clientPage.keyboard.press("Escape");
	await expect(clientSheet).toHaveCount(0);

	// Live on both computers: the rows, the bars' names and avatars.
	for (const [row, bar] of [
		[hostPage.locator("[data-sidebar-bot-row]"), hostBar],
		[deviceRow, clientBar],
	] as const) {
		await expect(row).toContainText("Nova", { timeout: 30_000 });
		await expect(row.locator("[data-sidebar-bot]")).toHaveAttribute("data-bot-avatar", "rocket");
		await expect(bar.locator("[data-bot-name]")).toHaveText("Nova", { timeout: 30_000 });
		await expect(bar.locator("[data-bot-avatar]").first()).toHaveAttribute("data-bot-avatar", "rocket");
		// The avatar moves by the bot's state, the same on the row and the bar of either computer.
		await expect(row.locator("[data-sidebar-bot]")).toHaveAttribute("data-bot-motion", "idle", { timeout: 30_000 });
		await expect(bar.locator("[data-bot-avatar]").first()).toHaveAttribute("data-bot-motion", "idle");
	}

	// Settings › Bot on the paired computer has a section for the host's bot, showing what the host keeps.
	await pressShortcutUntilVisible(clientPage, "ControlOrMeta+Comma", clientPage.locator("[data-settings-page]"));
	await clientPage.locator('[data-settings-page] [data-settings-section="bot"]').click();
	const hostSection = clientPage.locator(`[data-bot-identity-host=${cssString(deviceId)}]`);
	await expect(hostSection).toContainText("Bot on PC-B", { timeout: 30_000 });
	await expect(hostSection.locator("[data-bot-name-field]")).toHaveValue("Nova");
	await expect(hostSection.locator("[data-bot-tagline-field]")).toHaveValue("Keeps CI green");
	await commitField(hostSection.locator("[data-bot-tagline-field]"), "On call tonight");
	await expect.poll(async () => (await hostDesk()).identity?.tagline).toBe("On call tonight");
	await hostSection.scrollIntoViewIfNeeded();
	await capture(clientPage, "device-settings");
	await expect(hostBar.locator("[data-bot-tagline]")).toHaveText("On call tonight", { timeout: 30_000 });
	await clientPage.keyboard.press("Escape");

	// 3. The phone's page the paired computer serves, at 390 px: the drawer's host section, then the host's bot.
	await clientPage.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
	await expect
		.poll(
			() => clientPage.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "starting"),
			{ timeout: 60_000 },
		)
		.toBe("ready");
	const [site] = serveSites(tailscale);
	if (!site) throw new Error("no serve handler published");
	proxy = await ServeProxy.start(site, "seuput@example.com");
	browser = await chromium.launch();
	const phone = await (
		await browser.newContext({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, colorScheme: "light" })
	).newPage();
	phoneErrors = [];
	phone.on("pageerror", error => phoneErrors.push(error.stack ?? error.message));
	await phone.goto(`${proxy.url}/`);
	await phonePaired(phone);
	await phone.getByRole("button", { name: "Open menu" }).click();
	const phoneSection = phone.locator(`[data-drawer] [data-sidebar-device=${cssString(deviceId)}]`);
	const phoneRow = phoneSection.locator("[data-sidebar-bot-row]");
	await expect(phoneRow).toContainText("Nova", { timeout: 30_000 });
	await expect(phoneRow.locator("[data-sidebar-bot]")).toHaveAttribute("data-bot-avatar", "rocket");
	await phoneRow.click();
	const phoneBar = phone.locator("[data-bot-bar]");
	await expect(phoneBar.locator("[data-bot-name]")).toHaveText("Nova", { timeout: 60_000 });
	// Open in this window, the bot is awake: its avatar moves as it does on both computers (its row: below).
	await expect(phoneBar.locator("[data-bot-avatar]").first()).toHaveAttribute("data-bot-motion", "idle");
	await phoneBar.locator("[data-bot-identity-edit]").click();
	const phoneSheet = phone.locator(`[data-bot-identity-sheet=${cssString(deviceId)}]`);
	await expect(phoneSheet).toBeVisible();
	await expect(phone.locator('[data-sheet-placement="bottom"]')).toBeVisible();
	await phoneSheet.locator('[data-bot-avatar-color="success"]').click();
	await commitField(phoneSheet.locator("[data-bot-name-field]"), "Nova Prime");
	await expect.poll(hostTitle, { timeout: 30_000 }).toBe("Nova Prime");
	await expect
		.poll(async () => (await hostDesk()).identity?.avatar)
		.toEqual({
			kind: "mark",
			shape: "rocket",
			color: "success",
		});
	await expect(phoneSheet.locator("[data-bot-name-field]")).toHaveValue("Nova Prime", { timeout: 30_000 });
	await capture(phone, "phone-sheet");
	await phone.keyboard.press("Escape");
	await expect(phoneBar.locator("[data-bot-name]")).toHaveText("Nova Prime", { timeout: 30_000 });
	await capture(phone, "phone-bar");

	// What the phone changed reaches both computers' rows and bars at once.
	for (const page of [hostPage, clientPage])
		await expect(page.locator("[data-bot-bar] [data-bot-name]")).toHaveText("Nova Prime", { timeout: 30_000 });
	await expect(deviceRow).toContainText("Nova Prime");
	await expect(hostPage.locator("[data-sidebar-bot-row]")).toContainText("Nova Prime");
	// A rename made elsewhere reaches the phone's bar and drawer row too.
	await clientPage.evaluate(([file, device]) => window.omp.sessions.rename(file, "Nova Max", device), [
		botPath,
		deviceId,
	] as const);
	await expect(phoneBar.locator("[data-bot-name]")).toHaveText("Nova Max", { timeout: 30_000 });
	await phone.getByRole("button", { name: "Open menu" }).click();
	await expect(phoneRow).toContainText("Nova Max", { timeout: 30_000 });
	await expect(phoneRow.locator("[data-sidebar-bot]")).toHaveAttribute("data-bot-motion", "idle");
	await capture(phone, "phone-drawer");
	await capture(hostPage, "host-after");
	await capture(clientPage, "device-after");
});
