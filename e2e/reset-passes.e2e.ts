/**
 * Saved rate-limit resets ("reset passes") end to end on the fake omp
 * (`OMP_GUI_TEST_RESET_PASSES=1`): Settings › Models & providers shows each
 * Anthropic account's passes, holds the action for the account under its
 * limits, and for the account at its 5h limit explains the spend, redeems
 * through the bridge only after the confirmation, and shows the refreshed quota.
 * Nothing here reaches a real provider: the fixture stands in for stock's redeem.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, pressShortcutUntilVisible, recordsOfType } from "./harness";

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
const errors: string[] = [];

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-reset-passes-"));
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
			OMP_GUI_TEST_RESET_PASSES: "1",
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

test("shows each account's reset passes and spends one after confirming", async () => {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await page.locator('[data-settings-section="models"]').click();
	// No toggle: every account is its own open row, its reset passes under it.
	const work = settings.locator('[data-reset-passes="1"]');
	const home = settings.locator('[data-reset-passes="2"]');
	await expect(work).toContainText("1 reset pass");
	await expect(work).toContainText("Can't be used now: the provider doesn't allow it");
	await expect(work.getByRole("button", { name: "Use a reset pass for work@example.com" })).toBeDisabled();
	await expect(home).toContainText(/2 reset passes · expires \d{1,2}\/\d{1,2}/);

	await home.getByRole("button", { name: "Use a reset pass for home@example.com" }).click();
	const dialog = page.getByRole("dialog", { name: "Use a reset pass?" });
	await expect(dialog).toContainText("This spends 1 of the 2 reset passes on home@example.com (Anthropic).");
	await expect(dialog).toContainText(
		"Requests a reset of: 5-hour limit. The provider decides whether it can be applied.",
	);
	await expect(dialog).toContainText("Pass: One free rate limit reset");
	await expect(dialog).toContainText("claudeResets.autoRedeem");
	await expect(dialog).toContainText("A used pass can't be returned.");
	expect(await recordsOfType(record, "reset_pass_redeem")).toHaveLength(0);

	await dialog.getByRole("button", { name: "Use reset", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText("Reset applied for home@example.com")).toBeVisible();
	await expect(page.getByText("Now: 5-hour limit 0% used · Weekly limit 64% used")).toBeVisible();

	// The account's quota and passes come back refreshed: 5h free again, one pass left, nothing to spend it on.
	await expect(home).toContainText("1 reset pass · expires");
	await expect(home.getByRole("button", { name: "Use a reset pass for home@example.com" })).toBeDisabled();
	// The row's gauges show both windows (the 5-hour one free again, the weekly one at 64 % used); the full names
	// and resets are in the quota's tooltip.
	const homeRow = settings.locator('[data-provider-account="2"]');
	await expect(homeRow.locator('[data-window="5h"] .omp-usage-gauge-text')).toHaveText("5H0%");
	await expect(homeRow.locator('[data-window="7d"] .omp-usage-gauge-text')).toHaveText("7D64%");
	await expect(homeRow.locator("[data-quota-updated]")).toHaveAttribute("title", /5-hour limit · 0%/);
	const redeems = await recordsOfType(record, "reset_pass_redeem");
	expect(redeems).toHaveLength(1);
	expect(redeems[0]).toMatchObject({ providerId: "anthropic", credentialId: 2, creditId: "grant-home-1" });
	expect(errors).toEqual([]);
});
