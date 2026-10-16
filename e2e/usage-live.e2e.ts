/**
 * Live quotas end to end on the fake omp (`OMP_GUI_TEST_USAGE_DRIFT=1`): every
 * usage read after the first spends 5% more of work@'s 5-hour window, the way
 * a live account moves between polls. Settings › Models & providers keeps the
 * open account list current on its own (poll, window focus, a turn's end) and
 * says how old the numbers are and when each window resets; the refresh button
 * reaches the bridge as stock's invalidate. Playwright's clock stands in for
 * the 30-second wait. Nothing here reaches a real provider.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Locator, Page } from "playwright";
import { exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
const errors: string[] = [];

async function recorded(type: string): Promise<Array<Record<string, unknown>>> {
	const text = await fs.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry.type === type);
}

/** work@'s 5-hour share used as the account list's gauge shows it ("5H 15%"). */
async function workUsed(work: Locator): Promise<number> {
	const text = (await work.locator('[data-window="5h"] .omp-usage-gauge-text').textContent()) ?? "";
	const match = /^5H(\d+)%$/.exec(text);
	if (!match) throw new Error(`no 5-hour gauge in: ${text}`);
	return Number(match[1]);
}

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-usage-live-"));
	const project = path.join(profile, "project");
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(userData), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(userData, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop: userData,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_LOGIN: "1",
			OMP_GUI_TEST_MODELS: "1",
			OMP_GUI_TEST_USAGE_DRIFT: "1",
		},
	});
	page = await app.firstWindow();
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterAll(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("keeps the open account list live without reopening it", async () => {
	await page.clock.install();
	// The tab's usage poll starts as soon as the sidebar shows (it is on by default), with the real timers; a
	// reload restarts it under the fake clock this test drives.
	await page.reload();
	await page.waitForFunction(() => window.omp?.rpc != null);
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await page.locator('[data-settings-section="models"]').click();
	// No toggle: the account rows are open, each with a gauge per window (5H and 7D here).
	const work = settings.locator('[data-provider-account="1"]');
	await expect(work.locator('[data-window="5h"] .omp-usage-gauge-text')).toHaveText(/^5H\d+%$/);
	await expect(work.locator('[data-window="7d"] .omp-usage-gauge-text')).toHaveText(/^7D\d+%$/);
	const quota = work.locator("[data-quota-updated]");
	await expect(quota).toHaveAttribute("title", /Updated \d+s ago/);
	await expect(work).toContainText(/resets in [23]h \d+m/);
	const captures = process.env.OMP_GUI_WORK_BOARD_CAPTURES;
	if (captures) {
		await fs.mkdir(captures, { recursive: true });
		await page.screenshot({
			path: path.join(captures, "settings-accounts-en-light.png"),
			animations: "disabled",
			scale: "css",
		});
	}
	// The full window names, with their resets, are in the quota's tooltip.
	await expect(quota).toHaveAttribute("title", /resets in [34]d \d+h/);

	// The 30-second poll: the fixture's next read spent more, and the open list shows it.
	const before = await workUsed(work);
	await page.clock.fastForward(31_000);
	await expect.poll(() => workUsed(work)).toBeGreaterThan(before);

	// Coming back to the window reads at once.
	const beforeFocus = await workUsed(work);
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => workUsed(work)).toBeGreaterThan(beforeFocus);

	// The refresh button asks stock to probe the provider now (its `omp usage invalidate`).
	expect((await recorded("provider_accounts")).some(entry => entry.refresh === true)).toBe(false);
	await work.getByRole("button", { name: "Actions for Anthropic work@example.com" }).click();
	await page.getByRole("menuitem", { name: "Refresh Anthropic quotas" }).click();
	await expect
		.poll(async () => (await recorded("provider_accounts")).some(entry => entry.refresh === true))
		.toBe(true);
	expect(errors).toEqual([]);
});
