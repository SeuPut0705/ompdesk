import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { capture, exitApp, launchApp, recordsOfType } from "./harness";

// What a tab does while another one is in front (v0.8.0): its blocking dialogs and
// run-end notifications must still reach the user, and its sidebar row shows the run.
// Every test drives one tab through the fake omp's `fixture:*` commands while a second
// tab is focused, addressing the background tab's own omp with `commandForTab`. Plan
// cards, subagent rows and row states are component-tested (Sidebar, SidebarSubagents).

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
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_TEST_RECORD: record },
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
		.poll(async () =>
			(await recordsOfType(record, "extension_ui_response")).filter(entry => entry.id === "fixture-confirm"),
		)
		.toEqual([{ type: "extension_ui_response", id: "fixture-confirm", confirmed: true, recordedBy: owner }]);
	await expect(row).not.toContainText("Needs input");
	// The answer let the turn finish.
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
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

// The rows' states, subagent disclosure and order are component-tested (Sidebar, SidebarSubagents); this keeps the
// real layout and the captures.
test("a running row shows its run on the edge and keeps the whole title, at rest and on hover", async () => {
	const owner = await activeTab();
	await nameTab(owner, "Fan-out tab");
	await startRun("fixture running");
	// The run shows on the row's left edge, not as a spinner, and the title keeps the whole row: no padding is
	// reserved for actions at rest or on hover, so the title grows past the room the old layout kept (3.5rem+).
	const ownerRow = sidebarRow(owner);
	const titleBox = ownerRow.locator("button[data-roving-item]").locator("xpath=..");
	await expect(ownerRow).toHaveAttribute("data-signal", "running");
	await expect(ownerRow.locator(".omp-spinner, [role='status']")).toHaveCount(0);
	await expect(titleBox).toHaveCSS("padding-right", "0px");
	const restWidth = (await titleBox.boundingBox())?.width ?? 0;
	const rowWidth = (await ownerRow.boundingBox())?.width ?? 0;
	expect(restWidth).toBeGreaterThan(rowWidth * 0.4);
	await ownerRow.hover();
	await expect(titleBox).toHaveCSS("padding-right", "0px");
	expect((await titleBox.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(restWidth - 0.5);
	await page.mouse.move(0, 0);
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
		await capture(page, `sidebar-running-${scheme}`);
	}
	await fixtureCommand(owner, "fixture:confirm");
	await expect(ownerRow).toHaveAttribute("data-signal", "waiting");
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
		await capture(page, `sidebar-waiting-${scheme}`);
	}
	await page.emulateMedia({ colorScheme: "light" });
	await fixtureCommand(owner, "fixture:confirm:cancel");
	await fixtureCommand(owner, "fixture:finish");
	expect(errors).toEqual([]);
});
