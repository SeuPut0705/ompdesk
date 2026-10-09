import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

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
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_RECORD: record,
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
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function tabs() {
	return page.evaluate(() => window.omp.tabs.list());
}

async function sessionIdOf(tabId: string): Promise<string> {
	const response = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), tabId);
	const sessionId = (response.data as { sessionId?: unknown } | undefined)?.sessionId;
	if (typeof sessionId !== "string") throw new Error(`No session id for tab ${tabId}`);
	return sessionId;
}

/** The fake omp's launch line for one session: its argv and working directory. */
async function launchOf(sessionId: string): Promise<{ argv: string[]; cwd: string }> {
	const text = await fs.readFile(record, "utf8");
	const launch = text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { type?: unknown; recordedBy?: unknown; argv?: unknown; cwd?: unknown })
		.find(entry => entry.type === "launch" && entry.recordedBy === sessionId);
	if (!Array.isArray(launch?.argv) || typeof launch.cwd !== "string") throw new Error(`No launch for ${sessionId}`);
	return { argv: launch.argv.map(String), cwd: await fs.realpath(launch.cwd) };
}

test("a chat tab runs omp with every tool in the default workspace", async () => {
	// A fresh agent tab (⌘T) in the startup project is the reference launch.
	const [startup] = await tabs();
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(2);
	const agentTab = (await tabs()).find(tab => tab.tabId !== startup?.tabId);
	if (!agentTab) throw new Error("No agent tab");
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === agentTab.tabId)?.status).toBe("ready");
	const agentLaunch = await launchOf(await sessionIdOf(agentTab.tabId));
	expect(agentLaunch.cwd).toBe(await fs.realpath(project));

	// ⇧⌘T from inside that project: the chat still leaves the project behind.
	await page.keyboard.press("ControlOrMeta+Shift+t");
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
	await expect(page.locator("[data-composer-modes-trigger]")).toBeVisible();
	await page.locator("[data-run-settings-trigger]").click();
	await expect(page.locator("select[data-approval-mode]")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.locator("select[data-approval-mode]")).toHaveCount(0);

	const todo = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:todo" }),
		chat.tabId,
	);
	expect(todo).toMatchObject({ success: true });
	await expect(page.getByTestId("workspace-dock")).toBeVisible();

	const aside = page.locator("aside[data-docked]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
	for (const name of ["Changes", "Files", "Logs", "Queue", "Tree", "Jobs"]) {
		await expect(aside.getByRole("tab", { name, exact: true })).toBeVisible();
	}
	await aside.getByRole("tab", { name: "Tree", exact: true }).click();
	await expect(aside.getByRole("tab", { name: "Tree", exact: true })).toHaveAttribute("aria-selected", "true");
	expect(errors).toEqual([]);
});
