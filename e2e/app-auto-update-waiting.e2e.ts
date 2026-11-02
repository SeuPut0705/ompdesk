/**
 * Past its max wait the automatic install never restarts over running background work (src/main/app-auto-update.ts,
 * the limit the 2 Nov 2026 fix left): it tells the owner once that the update is ready and which running tasks hold
 * it, with "Restart now" (saying what it would interrupt) and "Later", and installs at the next safe point. The notice
 * looks and behaves the same on this computer (sidebar card, Settings › Updates), on a paired computer (Settings ›
 * Updates › the host's row) and on the phone page at 390 px (drawer card, Settings, the confirm sheet). Each surface
 * is captured.
 *
 * The update: macOS stages a stand-in bundle (relaunch mode, `e2e/fixture/stand-in-bundle.ts`); Windows pretends an
 * NSIS update whose install only quits (`OMP_DEV_UPDATE_STAGED`, `devDryInstall` in updater.ts). The max wait is cut
 * to a few seconds (`OMP_DEV_UPDATE_AUTO_MAX_WAIT_MS`); the background subagent is the fake omp's `Watcher`
 * (`OMP_GUI_TEST_BACKGROUND_JOB=1`, until `fixture:finish-background`).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { devices, expect, type Page, test, webkit } from "@playwright/test";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { stagedUpdateEnv } from "./fixture/stand-in-bundle";
import { capture, exitApp } from "./harness";
import {
	connectHost,
	launchRemote,
	makeRemoteProfile,
	openHostFolder,
	REMOTE_LOGIN,
	type RemoteInstance,
} from "./remote-harness";

const VERSION = "99.0.0";
const COUNTDOWN_MS = 3000;
const MAX_WAIT_MS = 3000;
const LABEL = `Update ${VERSION} waits · 1 running`;
const RESTART_NOW = "Restart now (interrupts Watcher)";
const HINT = `OMPdesk ${VERSION} is ready. It waits for Watcher to finish, then installs by itself.`;
const CUTS = "Restarting now interrupts Watcher. They start over after the restart.";

/** The automatic install's decision lines in the host's `gui-runtime.jsonl` (source `app-update`, message `scheduler`). */
async function schedulerEvents(desktop: string): Promise<string[]> {
	const log = await fs.readFile(path.join(desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => "");
	return log.split("\n").flatMap(line => {
		try {
			const entry = JSON.parse(line) as { source?: string; message?: string; details?: { event: string } };
			return entry.source === "app-update" && entry.message === "scheduler" && entry.details
				? [entry.details.event]
				: [];
		} catch {
			return [];
		}
	});
}

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

test("past the max wait the update waits for running background work and says so, the same here, on a paired computer and on the phone", async () => {
	test.setTimeout(300_000);
	const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-update-waiting-")));
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
			// Off until the turn's subagent runs, so the scheduler's first look already sees it.
			prefs: { appAutoUpdate: false },
			env: {
				...update,
				OMP_DEV_UPDATE_AUTO_MAX_WAIT_MS: String(MAX_WAIT_MS),
				OMP_GUI_TEST_BACKGROUND_JOB: "1",
			},
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

		// The owner's turn leaves a background subagent working; then the switch goes on.
		const input = b.locator(".omp-composer-input").first();
		await input.fill("fixture background subagent");
		await input.press("Enter");
		await expect(b.getByText("Watcher is on the release build in the background.")).toBeVisible({ timeout: 30_000 });
		await b.evaluate(() => window.omp.prefs.set("appAutoUpdate", true));

		// Past the max wait: no countdown, no install; the waiting notice names the subagent, logged once.
		await expect
			.poll(async () => (await b.evaluate(() => window.omp.updater.getStatus())) as Record<string, unknown>, {
				timeout: 30_000,
			})
			.toMatchObject({ state: "downloaded", waitingFor: { tasks: 1, names: ["Watcher"] } });
		expect(await schedulerEvents(hostProfile.desktop)).toEqual(["waiting", "overdue"]);

		// This computer: the sidebar card, then Settings › Updates.
		const card = b.locator("[data-sidebar-update]");
		await expect(card).toHaveAttribute("aria-label", LABEL);
		await expect(card.getByRole("button", { name: RESTART_NOW })).toBeVisible();
		await capture(b, "local-sidebar-waiting");
		await openUpdates(b, false);
		const localNotice = b.locator('[data-testid="auto-install-waiting"]');
		await expect(localNotice).toContainText(HINT);
		await expect(localNotice.getByRole("button", { name: RESTART_NOW })).toBeVisible();
		await capture(b, "local-settings-waiting");

		// A paired computer: Settings › Updates on a tab of the host shows the host's notice, and Restart now asks first.
		const deviceId = await connectHost(b, a, "studio");
		await openHostFolder(a, deviceId, hostProfile.project);
		await openUpdates(a, false);
		const hostRow = a.locator("#setting-updates-host");
		const pairedNotice = hostRow.locator('[data-testid="auto-install-waiting"]');
		await expect(pairedNotice).toContainText(HINT, { timeout: 30_000 });
		await capture(a, "paired-settings-waiting");
		await pairedNotice.getByRole("button", { name: RESTART_NOW }).click();
		const confirm = a.getByRole("dialog").filter({ hasText: CUTS });
		await expect(confirm).toBeVisible();
		await capture(a, "paired-restart-confirm");
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(confirm).toHaveCount(0);

		// The phone at 390 px: the drawer's card, Settings, and the confirm sheet that names the work.
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
		await expect(phoneCard.getByRole("button", { name: RESTART_NOW })).toBeVisible();
		await capture(phone, "phone-390-drawer-waiting");
		await phone.goBack().catch(() => undefined);
		await expect(phone.locator("[data-drawer]")).toHaveCount(0);
		await openUpdates(phone, true);
		const phoneNotice = phone.locator('[data-testid="auto-install-waiting"]');
		await expect(phoneNotice).toContainText(HINT);
		expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
		await capture(phone, "phone-390-settings-waiting");
		await phoneNotice.getByRole("button", { name: RESTART_NOW }).click();
		const sheet = phone.locator('[data-host-sheet="update"]');
		await expect(sheet.locator("[data-host-cuts]")).toHaveText(CUTS);
		await capture(phone, "phone-390-restart-sheet");
		await phone.getByRole("button", { name: "Cancel" }).click();
		await expect(sheet).toHaveCount(0);
		expect(await schedulerEvents(hostProfile.desktop)).not.toContain("install");

		// Later, from the paired computer: the notice goes everywhere, and the install still waits for the subagent.
		await hostRow.getByRole("button", { name: "Later" }).click();
		await expect
			.poll(async () => "waitingFor" in (await b.evaluate(() => window.omp.updater.getStatus())), {
				timeout: 15_000,
			})
			.toBe(false);
		// The card falls back to the plain "ready" row; the waiting line is gone.
		await expect(card).not.toHaveAttribute("aria-label", LABEL);
		await expect(pairedNotice).toHaveCount(0, { timeout: 15_000 });
		await expect(phoneNotice).toHaveCount(0);
		await context.close();

		// The subagent reports back: the next safe point counts down and installs, on a last look that held new work.
		const exited = new Promise<void>(resolve => host?.app.process().once("exit", () => resolve()));
		const finished = await b.evaluate(() => window.omp.rpc.bash("fixture:finish-background"));
		expect(finished.success).toBe(true);
		await exited;
		expect(await schedulerEvents(hostProfile.desktop)).toEqual([
			"waiting",
			"overdue",
			"postponed",
			"safe",
			"countdown",
			"install",
		]);
	} finally {
		await browser.close().catch(() => undefined);
		await proxy?.close().catch(() => undefined);
		for (const instance of [client, host]) if (instance) await exitApp(instance.app).catch(() => undefined);
		expect(client?.errors ?? []).toEqual([]);
		await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
