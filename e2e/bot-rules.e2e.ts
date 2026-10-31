import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { type BotRule, parseBotRules } from "../src/shared/bot-rules";
import { exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

// Settings › Bot (BotRulesSection.tsx): the default rules show, a behavior change, an added rule and a deleted rule
// are each written to pref `botRules` in prefs.json, and a default rule reads in the UI language while its stored text
// stays English. `OMPDESK_BOT_RULES_SHOTS=<dir>` also keeps the screenshots there; they are attached to the report
// either way.

let app: ElectronApplication;
let page: Page;
let profile: string;
let desktop: string;
const errors: string[] = [];

async function start(language: "en" | "ko"): Promise<void> {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-rules-"));
	desktop = path.join(profile, "desktop");
	const project = path.join(profile, "project");
	const agent = path.join(profile, "agent");
	await Promise.all([desktop, project, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, firstRunComplete: true }));
	errors.length = 0;
	app = await launchApp({ project, desktop, agent, profile });
	page = await app.firstWindow();
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", page.locator("[data-settings-page]"));
	await page.locator('[data-settings-page] [data-settings-section="bot"]').click();
	await expect(page.locator("[data-bot-rules]")).toBeVisible();
}

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

/** The rules prefs.json holds, once main has written them. */
async function storedRules(): Promise<BotRule[] | null> {
	const raw = await fs.readFile(path.join(desktop, "prefs.json"), "utf8").catch(() => "{}");
	const prefs: unknown = JSON.parse(raw);
	if (typeof prefs !== "object" || prefs === null || !("botRules" in prefs) || !Array.isArray(prefs.botRules))
		return null;
	return parseBotRules(prefs.botRules);
}

async function capture(name: string): Promise<void> {
	const body = await page.locator("[data-settings-page]").screenshot({ animations: "disabled" });
	await test.info().attach(name, { body, contentType: "image/png" });
	const dir = process.env.OMPDESK_BOT_RULES_SHOTS;
	if (dir) {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, `${name}.png`), body);
	}
}

test("the rules screen lists the defaults and saves a change, an added rule and a delete in prefs", async () => {
	test.setTimeout(180_000);
	await start("en");
	// The bot is off on a fresh install: no row, no session. Its switch here turns it on.
	const botSwitch = page.locator("#setting-bot-enabled").getByRole("switch", { name: "Use the bot" });
	await expect(botSwitch).not.toBeChecked();
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveCount(0);
	expect(await page.evaluate(() => window.omp.prefs.get("bot"))).toBeUndefined();
	await botSwitch.click();
	await expect(botSwitch).toBeChecked();
	await expect
		.poll(() => page.evaluate(() => window.omp.prefs.get("bot")), { timeout: 30_000 })
		.toEqual(expect.any(String));
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveCount(1, { timeout: 30_000 });
	await botSwitch.click();
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveCount(0);
	const list = page.locator("[data-bot-rules]");
	await expect(list.locator("[data-bot-rule-action]")).toHaveCount(11);
	await expect(list.locator('[data-bot-rule-action="deploy"]')).toHaveText("Deploy or release");
	await expect(list.locator('[data-bot-rule-behavior="deploy"]')).toHaveValue("auto");
	await expect(list.locator('[data-bot-rule-behavior="payments"]')).toHaveValue("ask");
	await expect(list.locator('[data-bot-rule-behavior="edits"]')).toHaveValue("auto");
	expect(await storedRules()).toBeNull();
	await capture("bot-rules-defaults");

	await list.locator('[data-bot-rule-behavior="edits"]').selectOption("handoff");
	await expect.poll(storedRules).not.toBeNull();
	const afterChange = (await storedRules()) ?? [];
	expect(afterChange).toHaveLength(11);
	expect(afterChange.find(rule => rule.id === "edits")).toEqual({
		id: "edits",
		action: "Edit code",
		behavior: "handoff",
	});

	await page.locator("[data-bot-rule-new]").click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Add", exact: true }).click();
	await expect(dialog).toContainText("Describe the action.");
	await dialog.getByLabel("Action").fill("  Update dependencies  ");
	await dialog.getByLabel("When the bot wants to do it").selectOption("auto");
	await dialog.getByRole("button", { name: "Add", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(list.locator("[data-bot-rule-action]")).toHaveCount(12);
	await expect
		.poll(async () => (await storedRules())?.find(rule => rule.action === "Update dependencies")?.behavior)
		.toBe("auto");
	await capture("bot-rules-added");

	await page.getByRole("button", { name: "Actions for Force-push" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
	await expect(list.locator("[data-bot-rule-action]")).toHaveCount(11);
	await expect.poll(async () => (await storedRules())?.some(rule => rule.id === "force-push")).toBe(false);
	expect((await storedRules())?.some(rule => rule.action === "Update dependencies")).toBe(true);
});

test("a default rule reads in Korean while its stored text stays English", async () => {
	test.setTimeout(180_000);
	await start("ko");
	const list = page.locator("[data-bot-rules]");
	await expect(list.locator('[data-bot-rule-action="deploy"]')).toHaveText("배포 또는 릴리스");
	await expect(page.locator('[data-bot-rule-behavior="deploy"] option:checked')).toHaveText("묻지 않고");
	await expect(page.locator('[data-bot-rule-behavior="payments"] option:checked')).toHaveText("묻고 나서");
	await capture("bot-rules-ko");

	await page.locator('[data-bot-rule-behavior="deploy"]').selectOption("handoff");
	await expect.poll(storedRules).not.toBeNull();
	expect((await storedRules())?.find(rule => rule.id === "deploy")).toEqual({
		id: "deploy",
		action: "Deploy or release",
		behavior: "handoff",
	});
	await expect(list.locator('[data-bot-rule-action="deploy"]')).toHaveText("배포 또는 릴리스");
});
