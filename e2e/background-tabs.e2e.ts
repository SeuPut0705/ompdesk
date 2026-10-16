import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// What a tab does while another one is in front (v0.8.0): its blocking dialogs,
// plan proposals, run-end notifications, next-prompt suggestion and subagent
// rows must all still reach the user. Every test drives one tab through the
// fake omp's `fixture:*` commands while a second tab is focused, addressing the
// background tab's own omp with `commandForTab`.

interface Notification {
	title: string;
	body?: string;
}

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-background-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	// @legacy-next-prompt tests drive the extension's widget, which the renderer ignores while the built-in suggestions are on.
	const builtinNextPrompt = !test.info().tags.includes("@legacy-next-prompt");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, nextPromptSuggestions: builtinNextPrompt }),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_RECORD: record,
		// Tests tagged @session-files run on stock-shaped session files, so their rows come from the session index.
		OMP_GUI_TEST_SESSION_FILES: test.info().tags.includes("@session-files") ? "1" : "",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	// Capture desktop notifications in main instead of showing them.
	await app.evaluate(({ ipcMain }) => {
		const sink = globalThis as typeof globalThis & { __notifications?: Notification[] };
		sink.__notifications = [];
		ipcMain.removeHandler("system:notify");
		ipcMain.handle("system:notify", (_event, payload: Notification) => {
			sink.__notifications?.push({ title: payload.title, body: payload.body });
		});
	});
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tabs() {
	return page.evaluate(() => window.omp.tabs.list());
}

/** The focused tab's id. */
async function activeTab(): Promise<string> {
	const active = (await tabs()).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active.tabId;
}

/** ⌘T: a second tab takes the front, leaving the current one in the background. */
async function openTab(): Promise<string> {
	const before = (await tabs()).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
	const created = (await tabs()).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === created.tabId)?.status).toBe("ready");
	await expect.poll(activeTab).toBe(created.tabId);
	return created.tabId;
}

/** Run a fake-omp `fixture:*` command on one tab's own omp, focused or not. */
async function fixtureCommand(tabId: string, line: string): Promise<void> {
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, line] as const,
	);
	expect(response).toMatchObject({ success: true });
}

async function sessionIdOf(tabId: string): Promise<string> {
	const response = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), tabId);
	const sessionId = (response.data as { sessionId?: unknown } | undefined)?.sessionId;
	if (typeof sessionId !== "string") throw new Error(`No session id for tab ${tabId}`);
	return sessionId;
}

/** Name a tab (session_info_update) and wait until its sidebar row shows it. */
async function nameTab(tabId: string, title: string): Promise<void> {
	await fixtureCommand(tabId, `fixture:title:${title}`);
	await expect(sidebarRow(tabId)).toContainText(title);
}

/** A tab's live sidebar row (its session has no file yet, so it is keyed by the tab). */
function sidebarRow(tabId: string) {
	return page.locator(`[data-session-path="tab:${tabId}"]`);
}

async function switchTo(tabId: string): Promise<void> {
	await sidebarRow(tabId).locator("button[data-roving-item]").click();
	await expect.poll(activeTab).toBe(tabId);
}

async function recorded(type: string): Promise<Record<string, unknown>[]> {
	const text = await fs.readFile(record, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>)
		.filter(entry => entry.type === type);
}

function notifications(): Promise<Notification[]> {
	return app.evaluate(
		() => (globalThis as typeof globalThis & { __notifications?: Notification[] }).__notifications ?? [],
	);
}

async function startRun(text: string): Promise<void> {
	await page.locator("textarea").first().fill(text);
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
}

test("a background tab's confirm flags its sidebar row, shows on switch, and the answer reaches its omp", async () => {
	const background = await activeTab();
	await nameTab(background, "Staging deploy");
	await startRun("fixture running");
	const front = await openTab();
	await nameTab(front, "Front task");

	await fixtureCommand(background, "fixture:confirm");
	const row = sidebarRow(background);
	await expect(row).toContainText("Needs input");
	await expect(sidebarRow(front)).not.toContainText("Needs input");
	// The dialog belongs to the background tab, not the one in front.
	await expect(page.getByRole("dialog")).toHaveCount(0);

	await switchTo(background);
	const dialog = page.getByRole("region", { name: "Deploy to staging?" });
	await expect(dialog).toContainText("The agent wants to run the staging deploy script.");
	await dialog.getByRole("button", { name: "Approve", exact: true }).click();
	await expect(dialog).toHaveCount(0);

	const owner = await sessionIdOf(background);
	await expect
		.poll(async () => (await recorded("extension_ui_response")).filter(entry => entry.id === "fixture-confirm"))
		.toEqual([{ type: "extension_ui_response", id: "fixture-confirm", confirmed: true, recordedBy: owner }]);
	await expect(row).not.toContainText("Needs input");
	// The answer let the turn finish.
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("a plan proposed in the background shows its approval card after switching back", async () => {
	const background = await activeTab();
	await nameTab(background, "Planning tab");
	await openTab();

	await fixtureCommand(background, "fixture:plan");
	// The proposal belongs to the background tab: nothing shows in front.
	await expect(page.locator("[data-prompt-card]")).toHaveCount(0);

	await switchTo(background);
	const card = page.getByRole("region", { name: "Fixture rollout plan" });
	await expect(card).toContainText("Ship the background tab coverage.");
	await expect(card).toContainText("fixture-rollout.md");
	await expect(card.getByRole("button", { name: "Approve and execute" })).toBeEnabled();
	// Hydrate still re-syncs it from the background tab's own omp (get_plan_mode).
	const owner = await sessionIdOf(background);
	expect(await recorded("modes.get_plan_mode")).toContainEqual(expect.objectContaining({ recordedBy: owner }));
	expect(errors).toEqual([]);
});

test("a background run finishing notifies under that tab's name", async () => {
	// Notifications only fire while the window is unfocused. Headless windows are
	// never focused, but Playwright emulates page focus for its pages (one CDP
	// session cannot switch another's emulation off), so report the real state.
	await page.evaluate(() => {
		document.hasFocus = () => false;
	});
	const background = await activeTab();
	await nameTab(background, "Release notes run");
	await startRun("fixture running");
	const front = await openTab();
	await nameTab(front, "Front task");
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === background)?.status).toBe("running");
	expect(await notifications()).toEqual([]);

	await fixtureCommand(background, "fixture:finish");
	// The banner reads the background reply (main's run outcome carries its start).
	await expect.poll(notifications).toEqual([{ title: "Release notes run", body: "Background run finished" }]);
	// The row reports the unseen finish.
	await expect(sidebarRow(background).locator("[data-sidebar-done]")).toHaveCount(1);
	expect(errors).toEqual([]);
});

test("a background tab's next-prompt suggestion becomes the composer placeholder and survives an edited draft", {
	tag: "@legacy-next-prompt",
}, async () => {
	const suggestion = "Write the release notes next";
	const background = await activeTab();
	await nameTab(background, "Suggesting tab");
	await openTab();
	const composer = page.locator("textarea").first();

	await fixtureCommand(background, `fixture:next-prompt:${suggestion}`);
	await expect(composer).toBeVisible();
	await expect(composer).not.toHaveAttribute("placeholder", suggestion);

	await switchTo(background);
	await expect(composer).toHaveAttribute("placeholder", suggestion);
	await composer.fill("a draft of my own");
	// The extension clears its widget on input; the GUI keeps the suggestion.
	await fixtureCommand(background, "fixture:next-prompt:clear");
	await composer.fill("");
	await expect(composer).toHaveAttribute("placeholder", suggestion);
	await composer.press("Tab");
	await expect(composer).toHaveValue(suggestion);
	expect(errors).toEqual([]);
});

test("sidebar subagent rows start collapsed, expand on click, and a finished one leaves the list at once", async () => {
	const owner = await activeTab();
	await nameTab(owner, "Fan-out tab");
	// The main turn keeps running while its subagents work (5d1de7d: their marks last only that long).
	await startRun("fixture running");
	await openTab();
	await fixtureCommand(owner, "fixture:subagents");
	await switchTo(owner);

	const sessionKey = `tab:${owner}`;
	const toggle = page.locator(`[data-sidebar-subagents-toggle="${sessionKey}"]`);
	const rows = page.locator(`[data-sidebar-subagents="${sessionKey}"] [data-sidebar-subagent]`);
	// Two live subagents (the finished reviewer is not listed), folded away.
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(toggle).toHaveAccessibleName("Show subagents (2)");
	await expect(page.locator("[data-sidebar-subagent]")).toHaveCount(0);

	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toHaveAttribute("data-sidebar-subagent", "sa-explore");
	await expect(rows.nth(1)).toHaveAttribute("data-sidebar-subagent", "sa-nested");
	await expect(page.locator('[data-sidebar-subagent="sa-nested"]').locator("xpath=..")).toHaveAttribute(
		"data-subagent-depth",
		"1",
	);

	// A finished agent leaves the list and the count right away, though the main turn keeps running.
	const nested = page.locator('[data-sidebar-subagent="sa-nested"]');
	await fixtureCommand(owner, "fixture:subagents:finish:sa-nested");
	await expect(nested).toHaveCount(0);
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toHaveAttribute("data-sidebar-subagent", "sa-explore");
	await expect(toggle).toHaveAccessibleName("Hide subagents (1)");

	await fixtureCommand(owner, "fixture:subagents:finish:sa-explore");
	await expect(page.locator("[data-sidebar-subagent]")).toHaveCount(0);
	await expect(toggle).toHaveCount(0);
	await fixtureCommand(owner, "fixture:finish");
	expect(errors).toEqual([]);
});

test("a background session's sidebar row follows its run, dialogs, title, plan and subagents without a visit", {
	tag: "@session-files",
}, async () => {
	const background = await activeTab();
	await startRun("fixture running");
	// The run wrote the session file: this row is the session index's, keyed by that file.
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === background)?.sessionPath).toBeTruthy();
	const sessionPath = (await tabs()).find(tab => tab.tabId === background)?.sessionPath ?? "";
	const row = page.locator(`[data-session-path="${sessionPath}"]`);
	const front = await openTab();
	await expect(row).not.toHaveAttribute("data-live", "true");
	await expect(row).toContainText("Running");

	await fixtureCommand(background, "fixture:title:Release prep");
	await expect(row).toContainText("Release prep");

	await fixtureCommand(background, "fixture:confirm");
	await expect(row).toContainText("Needs input");
	await fixtureCommand(background, "fixture:confirm:cancel");
	await expect(row).not.toContainText("Needs input");
	await expect(row).toContainText("Running");

	const subagents = page.locator(`[data-sidebar-subagents-toggle="${sessionPath}"]`);
	await fixtureCommand(background, "fixture:subagents");
	await expect(subagents).toHaveAccessibleName("Show subagents (2)");
	await fixtureCommand(background, "fixture:subagents:finish:sa-nested");
	// The finished agent leaves the list and the count at once.
	await expect(subagents).toHaveAccessibleName("Show subagents (1)");
	await subagents.click();
	await expect(page.locator(`[data-sidebar-subagents="${sessionPath}"] [data-sidebar-subagent]`)).toHaveCount(1);
	await expect(page.locator(`[data-sidebar-subagent="sa-nested"]`)).toHaveCount(0);
	await subagents.click();
	await expect(subagents).toHaveAccessibleName("Show subagents (1)");

	await fixtureCommand(background, "fixture:finish");
	await expect(row).not.toContainText("Running");
	await expect(row.locator("[data-sidebar-done]")).toHaveCount(1);

	await fixtureCommand(background, "fixture:plan");
	await expect(row).toContainText("Needs approval");
	await expect(page.locator("[data-prompt-card]")).toHaveCount(0);

	// Every update above reached the row while the other tab stayed in front.
	expect(await activeTab()).toBe(front);
	expect(errors).toEqual([]);
});
