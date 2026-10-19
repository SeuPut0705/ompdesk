import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, pressShortcutUntilVisible, readRecords } from "./harness";

// A chat tab is a full agent session whose only difference is the missing
// project: stock omp with its default tool set, started in OMPdesk's default
// workspace, with the same composer modes, run settings, dock and side panel.

let app: ElectronApplication;
let page: Page;
let profile: string;
let project: string;
let record: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-chat-tools-"));
	project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			transcriptDetail: "full",
		}),
	);
	app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_RECORD: record } });
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tabs() {
	return page.evaluate(() => window.omp.tabs.list());
}

/**
 * Press a new-tab shortcut until `opened` holds. A key pressed while the
 * renderer is still mounting (slow CI runners) is lost; the press repeats only
 * while the tab is missing, so it never opens a second one.
 */
async function pressUntil(shortcut: string, opened: () => Promise<boolean>): Promise<void> {
	await expect(async () => {
		if (!(await opened())) await page.keyboard.press(shortcut);
		await expect.poll(opened, { timeout: 2_000 }).toBe(true);
	}).toPass({ timeout: 20_000 });
}

async function sessionIdOf(tabId: string): Promise<string> {
	const response = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), tabId);
	const sessionId = (response.data as { sessionId?: unknown } | undefined)?.sessionId;
	if (typeof sessionId !== "string") throw new Error(`No session id for tab ${tabId}`);
	return sessionId;
}

/** The fake omp's launch line for one session: its argv and working directory. */
async function launchOf(sessionId: string): Promise<{ argv: string[]; cwd: string }> {
	const launch = (await readRecords(record)).find(entry => entry.type === "launch" && entry.recordedBy === sessionId);
	if (!Array.isArray(launch?.argv) || typeof launch.cwd !== "string") throw new Error(`No launch for ${sessionId}`);
	return { argv: launch.argv.map(String), cwd: await fs.realpath(launch.cwd) };
}

test("a chat tab runs omp with every tool in the default workspace", async () => {
	// A fresh agent tab (⌘T) in the startup project is the reference launch.
	const [startup] = await tabs();
	await pressUntil("ControlOrMeta+t", async () => (await tabs()).length === 2);
	const agentTab = (await tabs()).find(tab => tab.tabId !== startup?.tabId);
	if (!agentTab) throw new Error("No agent tab");
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === agentTab.tabId)?.status).toBe("ready");
	const agentLaunch = await launchOf(await sessionIdOf(agentTab.tabId));
	expect(agentLaunch.cwd).toBe(await fs.realpath(project));

	// ⇧⌘T from inside that project: the chat still leaves the project behind.
	await pressUntil("ControlOrMeta+Shift+t", async () => (await tabs()).some(tab => tab.kind === "chat"));
	await expect.poll(async () => (await tabs()).find(tab => tab.kind === "chat")?.status).toBe("ready");
	const chat = (await tabs()).find(tab => tab.kind === "chat");
	if (!chat) throw new Error("No chat tab");
	await expect.poll(async () => (await tabs()).find(tab => tab.active)?.tabId).toBe(chat.tabId);

	const workspace = await fs.realpath(await page.evaluate(() => window.omp.sidecar.defaultWorkspace()));
	expect(workspace).not.toBe(await fs.realpath(os.homedir()));
	expect(await fs.realpath(chat.cwd)).toBe(workspace);
	const chatLaunch = await launchOf(await sessionIdOf(chat.tabId));
	expect(chatLaunch.argv).not.toContain("--no-tools");
	expect(chatLaunch.argv).toEqual(agentLaunch.argv);
	expect(chatLaunch.cwd).toBe(workspace);

	// Chat chrome: no project name, the no-project placeholder.
	await expect(page.locator(".omp-titlebar-project")).toHaveText("Chats");
	await expect(page.getByPlaceholder("Ask anything", { exact: true })).toBeVisible();

	// Every tool surface an agent session has.
	await expect(page.locator("[data-run-settings-trigger]")).toBeVisible();
	await page.locator("[data-run-settings-trigger]").click();
	await expect(page.locator("[data-approval-mode]")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-approval-mode]")).toHaveCount(0);

	const todo = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:todo" }),
		chat.tabId,
	);
	expect(todo).toMatchObject({ success: true });
	// The window is wide enough for the work board, which shows the todos (their dock strip steps aside).
	const board = page.getByRole("complementary", { name: "Work board", exact: true });
	await expect(board.locator('[data-board-section="todos"]')).toContainText("0/6");

	const aside = page.locator("aside[data-docked]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
	await aside.getByRole("button", { name: "View options", exact: true }).click();
	for (const name of ["Background tasks", "Plan", "Logs", "Queue", "Tree", "Memory"]) {
		await expect(page.getByRole("menuitemcheckbox", { name, exact: true })).toBeVisible();
	}
	await page.getByRole("menuitemcheckbox", { name: "Tree", exact: true }).click();
	await expect(aside.locator(".omp-panel-topbar")).toContainText("Tree");
	expect(errors).toEqual([]);
});

test("reference blocks stay readable and errors retain recovery actions", async () => {
	await page.evaluate(() => window.omp.rpc.command({ type: "prompt", message: "fixture transcript" }));
	await expect(page.getByRole("heading", { name: "변경 사항", exact: true })).toBeVisible();
	await expect(page.getByRole("table")).toContainText("타입 검사");
	await expect(page.getByRole("link", { name: "문서 보기" })).toHaveAttribute("href", "https://example.com/docs");
	const thinking = page.locator(".omp-thinking-header");
	await expect(thinking).toHaveAttribute("aria-expanded", "false");
	await thinking.click();
	await expect(page.locator(".omp-thinking-body")).toContainText("변경 범위를 확인");
	const error = page.locator(".omp-message-error");
	await expect(error.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
	await expect(error.getByRole("button", { name: "Change model", exact: true })).toBeVisible();
	await error.locator("summary").click();
	await expect(error.locator("pre")).toContainText("503 Service unavailable");
	await page.getByRole("button", { name: "Copy code", exact: true }).click();
	expect(errors).toEqual([]);
});
