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
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

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

test.beforeAll(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-reset-passes-"));
	const project = path.join(profile, "project");
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(userData), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(userData, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_RECORD: record,
		OMP_GUI_TEST_LOGIN: "1",
		OMP_GUI_TEST_MODELS: "1",
		OMP_GUI_TEST_RESET_PASSES: "1",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${userData}`],
		env,
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
	await settings.locator("button[aria-expanded]", { hasText: "Anthropic" }).first().click();

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
	expect(await recorded("reset_pass_redeem")).toHaveLength(0);

	await dialog.getByRole("button", { name: "Use reset", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText("Reset applied for home@example.com")).toBeVisible();
	await expect(page.getByText("Now: 5-hour limit 100% left · Weekly limit 36% left")).toBeVisible();

	// The account's quota and passes come back refreshed: 5h free again, one pass left, nothing to spend it on.
	await expect(home).toContainText("1 reset pass · expires");
	await expect(home.getByRole("button", { name: "Use a reset pass for home@example.com" })).toBeDisabled();
	await expect(settings.getByText("5-hour limit 100% left")).toBeVisible();
	const redeems = await recorded("reset_pass_redeem");
	expect(redeems).toHaveLength(1);
	expect(redeems[0]).toMatchObject({ providerId: "anthropic", credentialId: 2, creditId: "grant-home-1" });
	expect(errors).toEqual([]);
});
