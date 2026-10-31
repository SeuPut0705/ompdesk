import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { type BotRule, parseBotRules } from "../src/shared/bot-rules";
import { cssString, exitApp, launchApp, pressShortcutUntilVisible, recordsOfType } from "./harness";

// Settings › Bot (BotRulesSection.tsx): the default rules show, a behavior change, an added rule and a deleted rule
// are each written to pref `botRules` in prefs.json, and a default rule reads in the UI language while its stored text
// stays English. `OMPDESK_BOT_RULES_SHOTS=<dir>` also keeps the screenshots there; they are attached to the report
// either way.

let app: ElectronApplication;
let page: Page;
let profile: string;
let desktop: string;
const errors: string[] = [];
let record: string;

async function start(language: "en" | "ko"): Promise<void> {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-rules-"));
	desktop = path.join(profile, "desktop");
	const project = path.join(profile, "project");
	const agent = path.join(profile, "agent");
	await Promise.all([desktop, project, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, firstRunComplete: true }));
	errors.length = 0;
	record = path.join(profile, "rpc.jsonl");
	// The fake omp writes stock session files (OMP_GUI_TEST_SESSION_FILES): the bot's name reaches its file and the list.
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_TEST_RECORD: record, OMP_GUI_TEST_SESSION_FILES: "1" },
	});
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
	let botFile = "";
	await expect
		.poll(
			async () => {
				const value = await page.evaluate(() => window.omp.prefs.get("bot"));
				botFile = typeof value === "string" ? value : "";
				return botFile;
			},
			{ timeout: 30_000 },
		)
		.not.toBe("");
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveCount(1, { timeout: 30_000 });
	// Its tab open, with one turn: a session a tab holds is renamed through the omp that holds it, and the fake omp
	// writes the session it opened only once it holds an entry (as stock writes a session with content).
	await page.locator("[data-sidebar-bot-row] button").first().click();
	let botTab = "";
	await expect
		.poll(async () => {
			botTab =
				(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.sessionPath === botFile)?.tabId ?? "";
			return botTab;
		})
		.not.toBe("");
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === botTab)?.status, {
			timeout: 30_000,
		})
		.toBe("ready");
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), botTab);
	await expect.poll(() => fs.readFile(botFile, "utf8"), { timeout: 30_000 }).toContain('"type":"message"');
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", page.locator("[data-settings-page]"));
	await page.locator('[data-settings-page] [data-settings-section="bot"]').click();
	await expect(botSwitch).toBeChecked();
	// Its name is its session's title: set here, it sticks in the session file, the list and the sidebar row, and a
	// second name replaces the first.
	const name = page.locator("[data-bot-name]");
	await expect(name).toHaveValue("Bot");
	const listedTitle = async () =>
		(await page.evaluate(() => window.omp.sessions.list("global"))).find(row => row.path === botFile)?.title;
	for (const next of ["Jarvis", "Friday"]) {
		await name.fill(next);
		await name.press("Enter");
		await expect.poll(() => fs.readFile(botFile, "utf8"), { timeout: 30_000 }).toContain(`"title":"${next}"`);
		await expect.poll(listedTitle, { timeout: 30_000 }).toBe(next);
		await expect(page.locator("[data-sidebar-bot-row]")).toContainText(next);
		await expect(name).toHaveValue(next);
	}
	expect((await recordsOfType(record, "set_session_name")).map(frame => frame.name)).toEqual(["Jarvis", "Friday"]);
	// The bot turned off with its tab open: neither its row nor its tab comes back as a plain chat.
	await botSwitch.click();
	await expect(botSwitch).not.toBeChecked();
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveCount(0);
	await expect(page.locator(`[data-session-path=${cssString(botFile)}]`)).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await page.evaluate(() => window.omp.sessions.list("global"))).find(row => row.path === botFile)?.bot,
		)
		.toBe("off");
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
