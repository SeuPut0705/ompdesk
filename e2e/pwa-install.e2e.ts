/**
 * Installing the web page as an app, against the built app's real web server behind the fake Tailscale serve
 * prefix (`e2e/fixture/phone-serve.ts`):
 * - `/manifest.webmanifest` and every icon and screenshot it names are served and the manifest carries what the
 *   install UIs read (name, id, start_url, scope, standalone, 192/512 + maskable icons, narrow and wide
 *   screenshots, a new-session shortcut, no `orientation`);
 * - the service worker controls the page, and Chromium's own installability check (CDP
 *   `Page.getInstallabilityErrors`) reports nothing;
 * - the Help menu's "Install app" item calls the saved `beforeinstallprompt` event's `prompt()`;
 * - a first launch in an empty storage jar (what an installed iOS/Android app starts with) re-pairs silently
 *   through `/api/pair` and lands in the app, and the install item is gone while running standalone;
 * - an iPhone (its Safari user agent): the Share › Add to Home Screen steps, in Settings and in the sheet.
 * Captures (light) go to /tmp/pwa-install/ (override: OMP_GUI_PWA_INSTALL_DIR).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, request, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { en } from "../src/renderer/locales/en";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

const CAPTURES = process.env.OMP_GUI_PWA_INSTALL_DIR ?? "/tmp/pwa-install";

// A step that cannot find its element fails there, not at the end of the test's own timeout.
test.use({ actionTimeout: 30_000 });

interface Profile {
	root: string;
	desktop: string;
	env: Record<string, string>;
	tailscale: FixtureTailscale;
}

async function makeProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-pwa-install-")));
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
	return { root, desktop, env, tailscale };
}

async function shot(page: Page, name: string) {
	await fs.mkdir(CAPTURES, { recursive: true });
	await page.screenshot({ path: path.join(CAPTURES, `${name}.png`) });
}

/** The phone's app is up (its composer shows); on a miss, what the page said is in the captures. */
async function phoneReady(phone: Page, label: string) {
	await expect(phone.locator("[data-composer-input]").first())
		.toBeVisible({ timeout: 120_000 })
		.catch(async error => {
			await shot(phone, `${label}-no-composer`);
			console.log(
				"[phone body]",
				(
					await phone
						.locator("body")
						.innerText()
						.catch(() => "")
				).slice(0, 800),
			);
			throw error;
		});
}

async function openHelpMenu(phone: Page) {
	const help = phone.getByRole("button", { name: en["help.menu"], exact: true });
	// The drawer stays open after a menu item; otherwise the menu button opens it.
	if (!(await help.isVisible())) await phone.locator("header button:has(svg.lucide-menu)").click();
	await help.click();
	await phone.waitForTimeout(400);
}

async function openMobileWebSettings(phone: Page) {
	const settings = phone.locator('[data-destination="settings"]');
	if (!(await settings.isVisible())) await phone.locator("header button:has(svg.lucide-menu)").click();
	await settings.click();
	await phone.locator('[data-settings-section="connections"]').click();
}

/** Where the manifest's store-listing screenshots live; `OMP_GUI_PWA_SCREENSHOTS=1` rewrites them from this run. */
const SCREENSHOT_DIR = path.resolve("src/renderer/public/screenshots");

async function refreshScreenshots(browser: Browser, proxy: ServeProxy, narrow: Page) {
	await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
	await narrow.screenshot({ path: path.join(SCREENSHOT_DIR, "narrow.png"), scale: "css" });
	const wideContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
	const wide = await wideContext.newPage();
	await wide.goto(`${proxy.url}/`);
	await phoneReady(wide, "wide");
	await wide.screenshot({ path: path.join(SCREENSHOT_DIR, "wide.png") });
	await wideContext.close();
}

interface Manifest {
	id?: string;
	name?: string;
	short_name?: string;
	description?: string;
	start_url?: string;
	scope?: string;
	display?: string;
	orientation?: string;
	icons?: { src: string; sizes: string; purpose?: string }[];
	screenshots?: { src: string; sizes: string; form_factor?: string }[];
	shortcuts?: { name: string; url: string }[];
}

test("@smoke The page is installable: manifest, worker, no installability errors, the install item calls prompt(), a silent first launch", async () => {
	test.setTimeout(600_000);
	const profile = await makeProfile();
	let app: ElectronApplication | null = null;
	let proxy: ServeProxy | null = null;
	let passed = false;
	const browser = await chromium.launch();
	try {
		app = await electron.launch({
			args: [
				path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
				`--user-data-dir=${profile.desktop}`,
			],
			env: profile.env,
		});
		const desktop = await app.firstWindow();
		await desktop.waitForFunction(() => window.omp?.rpc != null);
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await desktop.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(
				async () => desktop.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "x"),
				{
					timeout: 60_000,
				},
			)
			.toBe("ready");
		const [target] = serveSites(profile.tailscale);
		if (!target) throw new Error("no serve handler");
		proxy = await ServeProxy.start(target, "seuput@example.com");

		// --- Android Chrome ---------------------------------------------------------------------------------
		const context = await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" });
		const phone = await context.newPage();
		phone.on("pageerror", error => console.log("[phone pageerror]", error.message));
		await phone.goto(`${proxy.url}/`);
		await phoneReady(phone, "android");
		if (process.env.OMP_GUI_PWA_SCREENSHOTS === "1") await refreshScreenshots(browser, proxy, phone);

		// The manifest, as the page links it and as the install UIs read it.
		const href = await phone.evaluate(
			() => document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? "",
		);
		expect(href).toBe(`${proxy.url}/manifest.webmanifest`);
		const manifestResponse = await context.request.get(href);
		expect(manifestResponse.status()).toBe(200);
		expect(manifestResponse.headers()["content-type"]).toContain("manifest+json");
		// The browser fetches the manifest without credentials: it must not need the device cookie.
		const bare = await request.newContext();
		expect((await bare.get(href)).status()).toBe(200);
		await bare.dispose();
		const manifest = (await manifestResponse.json()) as Manifest;
		expect(manifest).toMatchObject({
			id: "/",
			name: "OMPdesk",
			short_name: "OMPdesk",
			start_url: "/",
			scope: "/",
			display: "standalone",
		});
		expect(manifest.description).toBeTruthy();
		expect(manifest.orientation).toBeUndefined();
		expect(manifest.icons?.map(icon => `${icon.sizes}:${icon.purpose}`)).toEqual(
			expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]),
		);
		expect(manifest.screenshots?.map(shotEntry => shotEntry.form_factor)).toEqual(
			expect.arrayContaining(["narrow", "wide"]),
		);
		expect(manifest.shortcuts?.[0]?.url).toBe("/#/open?new=1");
		for (const asset of [...(manifest.icons ?? []), ...(manifest.screenshots ?? [])]) {
			const response = await context.request.get(`${proxy.url}${asset.src}`);
			expect(response.status(), asset.src).toBe(200);
			expect(response.headers()["content-type"], asset.src).toContain("image/png");
		}
		const touchIcon = await context.request.get(`${proxy.url}/apple-touch-icon.png`);
		expect(touchIcon.status()).toBe(200);
		const metas = await phone.evaluate(() => ({
			capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute("content"),
			mobileCapable: document.querySelector('meta[name="mobile-web-app-capable"]')?.getAttribute("content"),
			title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content"),
			status: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute("content"),
			touch: document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href,
			themes: [...document.querySelectorAll('meta[name="theme-color"]')].map(meta => meta.getAttribute("media")),
		}));
		expect(metas).toMatchObject({
			capable: "yes",
			mobileCapable: "yes",
			title: "OMPdesk",
			touch: `${proxy.url}/apple-touch-icon.png`,
		});
		expect(metas.status).toBeTruthy();
		expect(metas.themes).toHaveLength(2);

		// The worker controls the page (after the first load it claims it) and has a fetch handler.
		await phone.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		await phone.reload();
		await phoneReady(phone, "android");
		expect(await phone.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain("/sw.js");
		const worker = await context.request.get(`${proxy.url}/sw.js`);
		expect(await worker.text()).toMatch(/addEventListener\(\s*["']fetch["']/);

		// Chromium's own installability check.
		const cdp = await context.newCDPSession(phone);
		const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors")) as {
			installabilityErrors: { errorId: string; errorArguments: unknown[] }[];
		};
		expect(installabilityErrors).toEqual([]);

		// The install item calls the saved `beforeinstallprompt`'s prompt(). (Headless Chromium may or may not
		// fire the real event; this one is dispatched the way the browser does.)
		let promptCalls = 0;
		await phone.exposeFunction("recordPrompt", () => {
			promptCalls += 1;
		});
		await phone.evaluate(() => {
			const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
				prompt: async () => {
					await Reflect.get(window, "recordPrompt")();
				},
				userChoice: Promise.resolve({ outcome: "dismissed" }),
			});
			window.dispatchEvent(event);
		});
		await openHelpMenu(phone);
		await shot(phone, "android-light-help-menu-install");
		await phone.getByRole("menuitem", { name: en["web.install.menu"] }).click();
		await expect.poll(() => promptCalls).toBe(1);
		// A prompt can be used once: the item goes away until the browser offers another.
		await openHelpMenu(phone);
		await expect(phone.getByRole("menuitem", { name: en["web.install.menu"] })).toHaveCount(0);
		await phone.keyboard.press("Escape");

		// --- The installed app's first launch ----------------------------------------------------------------
		// An empty storage jar (iOS keeps a Home Screen app's apart from Safari's) and `display-mode: standalone`:
		// the page re-pairs on its own through /api/pair with the Tailscale identity and lands in the app, with
		// no install item.
		const launched = await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" });
		const standalone = await launched.newPage();
		// Chromium's emulated media has no display-mode, so the page's own query is answered the way an installed app's is.
		await standalone.addInitScript(() => {
			const original = window.matchMedia.bind(window);
			window.matchMedia = query => {
				const list = original(query);
				if (/display-mode:\s*standalone/.test(query)) Object.defineProperty(list, "matches", { value: true });
				return list;
			};
		});
		await standalone.goto(`${proxy.url}${manifest.start_url}`);
		await phoneReady(standalone, "standalone");
		await expect(standalone.locator('[data-pair-state="failed"]')).toHaveCount(0);
		await shot(standalone, "android-light-standalone-first-launch");
		await standalone.evaluate(() => {
			const event = new Event("beforeinstallprompt", { cancelable: true });
			window.dispatchEvent(event);
		});
		await openHelpMenu(standalone);
		await expect(standalone.getByRole("menuitem", { name: en["web.install.menu"] })).toHaveCount(0);
		await standalone.keyboard.press("Escape");
		await launched.close();

		// --- iPhone Safari's user agent ----------------------------------------------------------------------
		// WebKit refuses the `Secure` device cookie on http://localhost, so the iPhone's identity (user agent, touch
		// screen, viewport) runs in Chromium: the page decides from those, not from the engine.
		const iphoneContext = await browser.newContext({ ...devices["iPhone 15"], colorScheme: "light" });
		const iphone = await iphoneContext.newPage();
		await iphone.goto(`${proxy.url}/`);
		await phoneReady(iphone, "iphone");
		// The Help menu's item opens the steps in a sheet; closing it and then pressing Settings in the still open
		// drawer must stay in the app (a menu item that opens a sheet used to leave the history one entry short, and
		// the drawer closing then went back to about:blank).
		await openHelpMenu(iphone);
		await shot(iphone, "iphone-light-help-menu-install");
		await iphone.getByRole("menuitem", { name: en["web.install.menu"] }).click();
		const sheet = iphone.locator('[data-install-steps="ios-share"]');
		await expect(sheet).toBeVisible();
		await expect(sheet).toContainText(en["web.install.ios2"]);
		await iphone.waitForTimeout(500);
		await shot(iphone, "iphone-light-install-sheet");
		await iphone.locator("[data-install-sheet-close]").click();
		await expect(sheet).toHaveCount(0);
		await openMobileWebSettings(iphone);
		expect(iphone.url()).toBe(`${proxy.url}/`);
		const section = iphone.locator('[data-web-install="ios-share"]');
		await section.scrollIntoViewIfNeeded();
		await expect(section).toBeVisible();
		await expect(section).toContainText(en["web.install.ios2"]);
		await shot(iphone, "iphone-light-settings-install");
		passed = true;
	} finally {
		await browser.close();
		await proxy?.close();
		if (app) await exitApp(app).catch(() => undefined);
		if (passed) await fs.rm(profile.root, { recursive: true, force: true }).catch(() => undefined);
		else console.log("[profile kept]", profile.root);
	}
});
