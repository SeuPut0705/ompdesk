/**
 * A notification tapped while the phone's app is not open: the service worker opens `/#/open?tab=<id>`
 * (sw-core.ts `notificationOpenUrl`), and that page starts from the last run's ghost strip before the host lists
 * its tabs. The notified tab must come forward anyway (lib/notification-click.ts waits for the list), and the hash
 * goes once routed, so a reload later opens where the person is, not the notified tab again (web-boot.ts).
 * The built app's real web server behind the fake `tailscale serve`, WebKit as an iPhone 15.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { devices, expect, type Page, test, webkit } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

async function activeTab(page: Page): Promise<string | undefined> {
	return (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
}

/**
 * The page is paired and its host answers. The title bar says nothing: a new device's first `/` renders the app
 * before `/api/session` refuses it and the page moves to `/pair`. Then a tap, as a person's, ends the launch moment
 * (sw-update.ts `ResumeGate`), so no update or failed-chunk reload lands on the page while the test works in it.
 */
async function inUse(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page
					.evaluate(async () => location.pathname === "/" && Array.isArray(await window.omp.tabs.list()))
					.catch(() => false),
			{ timeout: 60_000 },
		)
		.toBe(true);
	await page.locator("[data-composer-input]").first().click();
}

/** The strip the next start paints first (lib/tab-snapshot.ts) holds these tabs with `active` selected. */
async function stripWritten(page: Page, tabs: string[], active: string): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(
				({ tabs, active }) =>
					Object.keys(localStorage)
						.filter(key => /^omp\.snap\.\d+\.tabs\./.test(key))
						.map(key => localStorage.getItem(key) ?? "")
						.some(
							value =>
								value.includes(`"activeTabId":"${active}"`) && tabs.every(tab => value.includes(`"${tab}"`)),
						),
				{ tabs, active },
			),
		)
		.toBe(true);
}

test("a tapped notification opens its tab on a cold start, and the link is spent once routed", async () => {
	test.setTimeout(180_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-notify-open-")));
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
		...tailscale.env,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	let app: ElectronApplication | null = null;
	let proxy: ServeProxy | null = null;
	const browser = await webkit.launch();
	try {
		app = await electron.launch({
			args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${desktop}`],
			env,
		});
		const desk = await app.firstWindow();
		await desk.waitForFunction(() => window.omp?.rpc != null);
		await desk.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => desk.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(tailscale).at(-1);
		if (!site) throw new Error("serve publishes no handler");
		proxy = await ServeProxy.start(site, "seuput@example.com", undefined, { plainCookie: true });

		const context = await browser.newContext({ ...devices["iPhone 15"] });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`);
		await inUse(phone);
		const spawn = () =>
			phone.evaluate(async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId ?? null, project);
		const first = await spawn();
		const notified = await spawn();
		if (!first || !notified) throw new Error("no tabs");
		await phone.evaluate(id => window.omp.tabs.setActive(id), first);
		await phone.reload();
		await inUse(phone);
		await expect.poll(() => activeTab(phone)).toBe(first);
		// The strip is the next start's first frame (ghosts).
		await stripWritten(phone, [first, notified], first);
		await phone.close();

		// The worker's openWindow: a new page at the notification's link, the strip still last run's.
		const opened = await context.newPage();
		await opened.goto(`${proxy.url}/#/open?tab=${notified}`);
		await expect(opened.locator("[data-composer-input]").first()).toBeEditable({ timeout: 60_000 });
		await expect.poll(() => activeTab(opened), { timeout: 15_000 }).toBe(notified);
		await expect.poll(() => opened.evaluate(() => location.hash)).toBe("");

		// The person goes back to the first tab; a reload keeps them there.
		await inUse(opened);
		await opened.evaluate(id => window.omp.tabs.setActive(id), first);
		await stripWritten(opened, [first, notified], first);
		await opened.reload();
		await inUse(opened);
		expect(await opened.evaluate(() => location.hash)).toBe("");
		await expect.poll(() => activeTab(opened)).toBe(first);
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		if (app) await exitApp(app).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
	}
});
