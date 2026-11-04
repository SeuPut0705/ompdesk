/**
 * The automatic install's countdown notice with a background subagent still running (it no longer holds the
 * restart): "OMPdesk restarts in Ns" with Now and Later looks and behaves the same on this computer (sidebar card,
 * Settings › Updates), on a paired computer (Settings › Updates › the host's row) and on the phone page at 390 px
 * (drawer card, Settings). Each surface is captured into ~/motion-shots/update-restart-now/.
 *
 * The update: macOS stages a stand-in bundle (relaunch mode, `e2e/fixture/stand-in-bundle.ts`); Windows pretends an
 * NSIS update whose install only quits (`OMP_DEV_UPDATE_STAGED`). The subagent is the fake omp's `Watcher`
 * (`OMP_GUI_TEST_BACKGROUND_JOB=1`), never finished here. The countdown is long enough to visit every surface; Later
 * from the paired computer ends it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { devices, expect, type Page, test, webkit } from "@playwright/test";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { stagedUpdateEnv } from "./fixture/stand-in-bundle";
import { captureTo, exitApp } from "./harness";
import {
	connectHost,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	REMOTE_LOGIN,
	type RemoteInstance,
} from "./remote-harness";

const VERSION = "99.0.0";
const COUNTDOWN_MS = 240_000;
const SHOTS = path.join(os.homedir(), "motion-shots", "update-restart-now");
const LABEL = /restarting in \d+s/;

/** Settings › Updates & about on `page` (a phone pushes the section page). */
async function openUpdates(page: Page, phone: boolean): Promise<void> {
	if (phone) {
		await page.locator("header button:has(svg.lucide-menu)").click();
		await page.locator('[data-drawer] [data-destination="settings"]').click();
	} else {
		await page.locator('.omp-session-sidebar [data-destination="settings"]').click();
	}
	await page.locator('[data-settings-section="updates"]').click();
}

test("the restart countdown shows the same here, on a paired computer and on the phone while a background subagent runs", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-update-parity-")));
	let host: RemoteInstance | undefined;
	let client: RemoteInstance | undefined;
	let proxy: ServeProxy | null = null;
	const browser = await webkit.launch();
	try {
		const updateRoot = path.join(parent, "update");
		await fs.mkdir(updateRoot);
		const update =
			process.platform === "darwin"
				? (await stagedUpdateEnv(updateRoot, updateRoot, VERSION, COUNTDOWN_MS)).env
				: {
						OMP_DEV_UPDATE_STAGED: "1",
						OMP_DEV_UPDATE_STAGED_VERSION: VERSION,
						OMP_DEV_UPDATE_AUTO_COUNTDOWN_MS: String(COUNTDOWN_MS),
					};
		const hostProfile = await makeRemoteProfile(parent, "studio", {
			language: "en",
			theme: "light",
			// Off until the turn's subagent runs.
			prefs: { appAutoUpdate: false },
			env: { ...update, OMP_GUI_TEST_BACKGROUND_JOB: "1" },
		});
		const clientProfile = await makeRemoteProfile(parent, "laptop", {
			language: "en",
			theme: "light",
			port: hostProfile.port,
		});
		host = await launchRemote(hostProfile);
		client = await launchRemote(clientProfile);
		const b = host.page;
		const a = client.page;
		await expect
			.poll(() => b.evaluate(async () => (await window.omp.updater.getStatus()).state), { timeout: 15_000 })
			.toBe("downloaded");

		const input = b.locator(".omp-composer-input").first();
		await input.fill("fixture background subagent");
		await input.press("Enter");
		await expect(b.getByText("Watcher is on the release build in the background.")).toBeVisible({ timeout: 30_000 });
		await b.evaluate(() => window.omp.prefs.set("appAutoUpdate", true));
		await expect
			.poll(
				async () =>
					"restartAt" in ((await b.evaluate(() => window.omp.updater.getStatus())) as Record<string, unknown>),
				{ timeout: 30_000 },
			)
			.toBe(true);

		// This computer: the sidebar card, then Settings › Updates.
		const card = b.locator("[data-sidebar-update]");
		await expect(card).toHaveAttribute("aria-label", LABEL);
		await expect(card.getByRole("button", { name: "Now", exact: true })).toBeVisible();
		await captureTo(SHOTS, b, "local-sidebar-countdown");
		await openUpdates(b, false);
		await expect(b.locator('[data-testid="auto-restart-notice"]')).toContainText(LABEL);
		await captureTo(SHOTS, b, "local-settings-countdown");

		// A paired computer: the host's row in Settings › Updates.
		const deviceId = await connectHost(b, a, "studio");
		await openHostFolder(a, deviceId, hostProfile.project);
		await openUpdates(a, false);
		const hostRow = a.locator("#setting-updates-host");
		const pairedNotice = hostRow.locator('[data-testid="auto-restart-notice"]');
		await expect(pairedNotice).toContainText(LABEL, { timeout: 30_000 });
		await captureTo(SHOTS, a, "paired-settings-countdown");

		// The phone at 390 px: the drawer's card and Settings.
		await b.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
		await expect
			.poll(() => b.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
			.toBe("ready");
		await expect.poll(() => serveSites(hostProfile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
		const site = serveSites(hostProfile.tailscale).at(-1);
		if (!site) throw new Error("serve publishes no handler");
		proxy = await ServeProxy.start(site, REMOTE_LOGIN, undefined, { plainCookie: true });
		const context = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 390, height: 844 } });
		const phone = await context.newPage();
		await phone.goto(`${proxy.url}/`, { timeout: 60_000 });
		await phonePaired(phone);
		await phone.locator("header button:has(svg.lucide-menu)").click();
		const phoneCard = phone.locator("[data-drawer] [data-sidebar-update]");
		await expect(phoneCard).toHaveAttribute("aria-label", LABEL, { timeout: 30_000 });
		await expect(phoneCard.getByRole("button", { name: "Now", exact: true })).toBeVisible();
		await captureTo(SHOTS, phone, "phone-390-drawer-countdown");
		await phone.goBack().catch(() => undefined);
		await expect(phone.locator("[data-drawer]")).toHaveCount(0);
		await openUpdates(phone, true);
		await expect(phone.locator('[data-testid="auto-restart-notice"]')).toContainText(LABEL);
		expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await captureTo(SHOTS, phone, "phone-390-settings-countdown");

		// Later, from the paired computer: the countdown goes everywhere.
		await hostRow.getByRole("button", { name: "Later" }).click();
		await expect
			.poll(async () => "restartAt" in (await b.evaluate(() => window.omp.updater.getStatus())), { timeout: 15_000 })
			.toBe(false);
		await expect(pairedNotice).toHaveCount(0, { timeout: 15_000 });
		await context.close();
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		for (const instance of [client, host]) if (instance) await exitApp(instance.app).catch(() => undefined);
		expect(client?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
