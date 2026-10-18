/**
 * A paired phone's appearance is its own: it sets dark while the computer stays light, across a page reload and
 * a relaunch of the computer, and a theme change on the computer never moves the phone (src/shared/device-prefs.ts,
 * the page's shim). Captures go to /tmp/device-prefs/ (override: OMP_GUI_DEVICE_PREFS_DIR).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, devices, expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { type FixtureTailscale, fixtureTailscale } from "./fixture/fake-tailscale-install";
import { ServeProxy, serveSites } from "./fixture/phone-serve";
import { exitApp, fixtureOmp } from "./harness";

const CAPTURES = process.env.OMP_GUI_DEVICE_PREFS_DIR ?? "/tmp/device-prefs";

interface Profile {
	root: string;
	desktop: string;
	env: Record<string, string>;
	tailscale: FixtureTailscale;
}

async function makeProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-device-prefs-")));
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

async function launch(profile: Profile) {
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page };
}

async function waitReady(page: Page) {
	await expect
		.poll(async () => page.evaluate(async () => (await window.omp.mobileWeb.getState()).phase).catch(() => "x"), {
			timeout: 60_000,
		})
		.toBe("ready");
}

const scheme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
const hostTheme = (page: Page) => page.evaluate(() => window.omp.prefs.get("themeName"));

async function shot(page: Page, name: string) {
	await fs.mkdir(CAPTURES, { recursive: true });
	await page.screenshot({ path: path.join(CAPTURES, `${name}.png`) });
}

/** The phone's app is up (its header menu shows; the session behind it may still be starting). */
async function phoneReady(phone: Page) {
	await expect(phone.locator("header button:has(svg.lucide-menu)").first())
		.toBeVisible({ timeout: 60_000 })
		.catch(async error => {
			await shot(phone, "no-app");
			console.log("[phone body]", (await phone.locator("body").innerText().catch(() => "")).slice(0, 800));
			throw error;
		});
}

async function openAppearance(phone: Page) {
	await phone.locator("header button:has(svg.lucide-menu)").click();
	await phone.locator('[data-destination="settings"]').click();
	await phone.locator('[data-settings-section="appearance"]').click();
	await expect(phone.locator("[data-device-prefs-note]")).toBeVisible();
}

async function pickTheme(phone: Page, name: "light" | "dark") {
	await phone.locator(`[data-theme-option="${name}"]`).scrollIntoViewIfNeeded();
	await phone.locator(`[data-theme-option="${name}"]`).click();
	await expect.poll(() => scheme(phone)).toBe(name);
}

/** The `uiPrefs` of the one paired device, as the host saved it to disk. */
async function savedDevicePrefs(profile: Profile): Promise<Record<string, unknown> | null> {
	const text = await fs.readFile(path.join(profile.desktop, "web-devices.json"), "utf8");
	const find = (node: unknown): Record<string, unknown> | null => {
		if (typeof node !== "object" || node === null) return null;
		const record = node as Record<string, unknown>;
		if (typeof record.uiPrefs === "object" && record.uiPrefs !== null)
			return record.uiPrefs as Record<string, unknown>;
		for (const child of Object.values(record)) {
			const found = find(child);
			if (found) return found;
		}
		return null;
	};
	return find(JSON.parse(text));
}

const savedHostTheme = async (profile: Profile) =>
	(JSON.parse(await fs.readFile(path.join(profile.desktop, "prefs.json"), "utf8")) as { themeName?: string })
		.themeName;

test("@smoke The phone sets dark while the computer stays light, across a reload and a relaunch; the computer's theme never moves the phone", async () => {
	test.setTimeout(400_000);
	const profile = await makeProfile();
	let current: ElectronApplication | null = null;
	const browser = await chromium.launch();
	let proxy: ServeProxy | null = null;
	try {
		const first = await launch(profile);
		current = first.app;
		expect(await scheme(first.page)).toBe("light");
		await first.page.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await waitReady(first.page);
		const [target] = serveSites(profile.tailscale);
		if (!target) throw new Error("no serve handler");
		proxy = await ServeProxy.start(target, "seuput@example.com");
		const context = await browser.newContext({ ...devices["Pixel 7"], colorScheme: "light" });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`);
		await phoneReady(phone);

		// Nothing set on the phone: it follows the system, not the computer's own choice.
		expect(await phone.evaluate(() => window.omp.prefs.get("themeName"))).toBeUndefined();
		await shot(phone, "01-phone-default-system");

		await openAppearance(phone);
		await shot(phone, "02-phone-appearance-this-device");
		await pickTheme(phone, "dark");
		await shot(phone, "03-phone-dark");

		// The computer did not move, in memory or on its disk.
		expect(await hostTheme(first.page)).toBe("light");
		expect(await scheme(first.page)).toBe("light");
		await shot(first.page, "04-desktop-still-light");

		// A reload of the page keeps the phone's choice.
		await phone.reload();
		await phoneReady(phone);
		await expect.poll(() => scheme(phone)).toBe("dark");

		// The computer restarts: the phone reconnects, still dark, the computer still light.
		await exitApp(current);
		current = null;
		expect(await savedHostTheme(profile)).toBe("light");
		expect((await savedDevicePrefs(profile))?.themeName).toBe("dark");
		const second = await launch(profile);
		current = second.app;
		await expect.poll(() => serveSites(profile.tailscale).length, { timeout: 60_000 }).toBeGreaterThan(0);
		await waitReady(second.page);
		proxy.retarget(serveSites(profile.tailscale).at(-1) ?? target);
		await phone.reload();
		await phoneReady(phone);
		await expect.poll(() => scheme(phone)).toBe("dark");
		expect(await scheme(second.page)).toBe("light");
		await shot(phone, "05-phone-dark-after-relaunch");
		await shot(second.page, "06-desktop-light-after-relaunch");

		// And the other way: the phone picks light, the computer goes dark, the phone stays light.
		await openAppearance(phone);
		await pickTheme(phone, "light");
		await second.page.evaluate(() => window.omp.prefs.set("themeName", "dark"));
		await phone.reload();
		await phoneReady(phone);
		await expect.poll(() => scheme(phone)).toBe("light");
		expect(await hostTheme(second.page)).toBe("dark");
		await shot(phone, "07-phone-light-computer-dark");
	} finally {
		await browser.close();
		await proxy?.close();
		if (current) await exitApp(current).catch(() => undefined);
		await fs.rm(profile.root, { recursive: true, force: true }).catch(() => undefined);
	}
});
