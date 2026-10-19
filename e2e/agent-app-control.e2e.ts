import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, readRecords } from "./harness";

// `ompdesk_app_list` / `ompdesk_app` (src/main/agent-control/app-*.ts): the main agent changes OMPdesk itself.
// The fake omp calls a host tool with `fixture:host-tool:<name> <json>` and records the result it gets. "Give agents
// full control of OMPdesk" is on unless stored `false`: then nothing raises a card (an erasing action included) and
// the agent may flip the agent-power switches. Stored off, "Let agents manage other sessions" decides: a sensitive
// action (an auto-update switch) runs without a card while it is on and asks with it stored off; an action that
// erases data (a saved session) asks either way; the agent-power switches are refused.

let app: ElectronApplication;
let page: Page;
let profile: string;
let desktop: string;
let record: string;
let errors: string[];
let main: string;

/** Launch a fresh profile; `prefs` seeds `prefs.json` (a pref left out is unset, which is the shipped default). */
async function start(prefs: Record<string, unknown> = {}): Promise<void> {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-app-"));
	const project = path.join(profile, "project");
	desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, batchNotifications: false, ...prefs }),
	);
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: record },
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	main = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	expect(main).not.toBe("");
}

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

async function results(): Promise<{ text: string; isError: boolean }[]> {
	const frames = await readRecords(record);
	return frames
		.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
		.map(frame => {
			const result = frame.result as { content?: { text?: string }[] } | undefined;
			return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
		});
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
	const before = (await results()).length;
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[main, `fixture:host-tool:${name} ${JSON.stringify(args)}`] as const,
	);
	expect(response).toMatchObject({ success: true });
	await expect.poll(async () => (await results()).length, { timeout: 90_000 }).toBe(before + 1);
	return (await results())[before] as { text: string; isError: boolean };
}

const app_ = (action: string, args: Record<string, unknown> = {}) => call("ompdesk_app", { action, args });
const themeName = () => page.evaluate(() => document.documentElement.getAttribute("data-theme-name"));
const storedPref = (key: string) => page.evaluate(k => window.omp.prefs.get(k), key);

test("the agent lists actions, changes the theme with a toast and undo, opens the preview panel and reads usage", async () => {
	test.setTimeout(150_000);
	await start();
	const listed = await call("ompdesk_app_list", { area: "ui" });
	expect(listed.isError).toBe(false);
	expect(listed.text).toContain("ui.panel [change]");
	expect(listed.text).toContain('"tab"');

	// First write: nothing was stored before, so no undo is offered.
	expect((await app_("settings.theme", { value: "dark" })).isError).toBe(false);
	await expect.poll(themeName).toBe("dark");
	await expect(page.getByText("Agent changed: Theme → dark")).toBeVisible();

	const changed = await app_("settings.theme", { value: "nord" });
	expect(changed.isError).toBe(false);
	expect(changed.text).toContain("Theme is now nord");
	await expect.poll(themeName).toBe("nord");
	expect(await storedPref("themeName")).toBe("nord");
	await expect(page.getByText("Agent changed: Theme → nord")).toBeVisible();
	await page.getByRole("button", { name: "Undo" }).click();
	await expect.poll(themeName).toBe("dark");
	await expect.poll(() => storedPref("themeName")).toBe("dark");

	const opened = await app_("ui.panel", { tab: "preview" });
	expect(opened.isError).toBe(false);
	await expect(page.getByRole("textbox", { name: "Preview URL" })).toBeVisible({ timeout: 30_000 });

	const usage = await app_("usage.read");
	expect(usage.isError).toBe(false);
	expect(usage.text).toMatch(/usage|%|No provider usage/);

	// The change is journaled in the agent's own session.
	await expect(page.getByText("Agent changed: Theme → nord").first()).toBeVisible();
});

test("with full control and manage stored off a sensitive action asks with the card and runs only when approved; agent-power switches are never reachable", async () => {
	test.setTimeout(150_000);
	await start({ agentControlFull: false, agentControlManage: false });
	const denied = app_("settings.cliAutoUpdate", { value: false });
	await page
		.getByRole("button", { name: /Needs input/ })
		.first()
		.click({ timeout: 30_000 });
	await expect(page.getByText("[OMPdesk]").first()).toBeVisible({ timeout: 30_000 });
	await page.getByRole("button", { name: /^Deny/ }).first().click();
	const refused = await denied;
	expect(refused.isError).toBe(true);
	expect(refused.text).toContain("The user declined");
	expect(await storedPref("cliAutoUpdate")).not.toBe(false);

	const approved = app_("settings.cliAutoUpdate", { value: false });
	await page
		.getByRole("button", { name: /Needs input/ })
		.first()
		.click({ timeout: 30_000 });
	await expect(page.getByText("[OMPdesk]").first()).toBeVisible({ timeout: 30_000 });
	await page
		.getByRole("button", { name: /^Approve/ })
		.first()
		.click();
	expect((await approved).isError).toBe(false);
	await expect.poll(() => storedPref("cliAutoUpdate")).toBe(false);

	for (const [action, args] of [
		["agent_power.set", { switch: "agentControlFull", on: true }],
		["settings.agentControlManage", { value: true }],
		["settings.tools.approvalMode", { value: true }],
		["cards.answer", { value: true }],
	] as const) {
		const result = await app_(action, args);
		expect(result.isError, action).toBe(true);
	}
	// The agent never flipped the switches the test seeded.
	expect(await storedPref("agentControlManage")).toBe(false);
	expect(await storedPref("agentControlFull")).toBe(false);
});

test("with full control stored off a sensitive action runs without a card, a deleting action still asks, and the switch is never written", async () => {
	test.setTimeout(150_000);
	await start({ agentControlFull: false });
	// Nothing stored: "Let agents manage other sessions" is on, so this needs no card.
	const changed = await app_("settings.cliAutoUpdate", { value: false });
	expect(changed.isError).toBe(false);
	await expect.poll(() => storedPref("cliAutoUpdate")).toBe(false);
	await expect(page.getByText("[OMPdesk]")).toHaveCount(0);

	// Erasing a saved session asks whatever the switch says; a refusal runs nothing.
	const erased = app_("sessions.delete", { sessionPath: path.join(profile, "agent", "never-saved.jsonl") });
	await page
		.getByRole("button", { name: /Needs input/ })
		.first()
		.click({ timeout: 30_000 });
	await expect(page.getByText("[OMPdesk]").first()).toBeVisible({ timeout: 30_000 });
	await page.getByRole("button", { name: /^Deny/ }).first().click();
	const refused = await erased;
	expect(refused.isError).toBe(true);
	expect(refused.text).toContain("The user declined");

	expect(await storedPref("agentControlManage")).toBeUndefined();
	expect(await storedPref("agentControlApprove")).toBeUndefined();
});

test("by default (full control) erasing and sensitive actions run without a card and the agent may change its own switches, never answer a card", async () => {
	test.setTimeout(150_000);
	await start();
	expect((await app_("settings.cliAutoUpdate", { value: false })).isError).toBe(false);
	const erased = await app_("sessions.delete", { sessionPath: path.join(profile, "agent", "never-saved.jsonl") });
	expect(erased.text).not.toContain("declined");
	const power = await app_("agent_power.set", { switch: "agentControlApprove", on: true });
	expect(power.isError, power.text).toBe(false);
	await expect.poll(() => storedPref("agentControlApprove")).toBe(true);
	expect((await app_("cards.answer", {})).isError).toBe(true);
	expect((await app_("credentials.read", {})).isError).toBe(true);
	await expect(page.getByText("[OMPdesk]")).toHaveCount(0);
});
