import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp, readRecords } from "./harness";

// The bot (src/main/agent-control/bot.ts, kept by bot-home.ts): a fresh app with no setup has one bot row at the top of
// the sidebar and its session. A question card of a session the owner runs wakes it with a report (the fake omp's
// `agent_control.mail` runs a turn whose reply names the report), its answer through the control tools reaches the
// card, and the session's finished turn is then reported without waking it. Which sessions and kinds count is
// unit-tested in bot.test.ts, and the keeping of the session in bot-home.test.ts.

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let errors: string[];
let dirs: { project: string; desktop: string; agent: string };

async function start(): Promise<void> {
	app = await launchApp({
		...dirs,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: record, OMP_GUI_TEST_SESSION_FILES: "1" },
	});
	page = await app.firstWindow();
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
}

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-bot-"));
	dirs = {
		project: path.join(profile, "project"),
		desktop: path.join(profile, "desktop"),
		agent: path.join(profile, "agent"),
	};
	await Promise.all(Object.values(dirs).map(dir => fs.mkdir(dir)));
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(
		path.join(dirs.desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true }),
	);
	errors = [];
	await start();
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

async function toolResults(): Promise<{ text: string; isError: boolean }[]> {
	return (await readRecords(record))
		.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
		.map(frame => {
			const result = frame.result as { content?: { text?: string }[] } | undefined;
			return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
		});
}

/** The main agent of `tabId` calls a control tool; resolves with the result it gets back. */
async function callAs(tabId: string, name: string, args: Record<string, unknown>) {
	const before = (await toolResults()).length;
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, `fixture:host-tool:${name} ${JSON.stringify(args)}`] as const,
	);
	expect(response).toMatchObject({ success: true });
	await expect.poll(async () => (await toolResults()).length, { timeout: 60_000 }).toBe(before + 1);
	return (await toolResults())[before] as { text: string; isError: boolean };
}

async function lastAnswer(tabId: string): Promise<string> {
	const response = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "get_last_assistant_text" }),
		tabId,
	);
	return (response.data as { text?: string | null } | undefined)?.text ?? "";
}

/** The file main keeps as the bot's session, once it made one. */
async function botFile(): Promise<string> {
	let found = "";
	await expect
		.poll(async () => {
			const value = await page.evaluate(() => window.omp.prefs.get("bot"));
			found = typeof value === "string" ? value : "";
			return found;
		})
		.not.toBe("");
	return found;
}

/** The tab holding `file`, once a tab does. */
async function tabOf(file: string): Promise<string> {
	let found = "";
	await expect
		.poll(async () => {
			found = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.sessionPath === file)?.tabId ?? "";
			return found;
		})
		.not.toBe("");
	return found;
}

test("a fresh app has the bot row and its session, and a question in another session wakes it with no setup", async () => {
	test.setTimeout(150_000);
	// Nothing was set up: main made the bot's session (titled, listed) and the sidebar's first row is the bot.
	const file = await botFile();
	expect(file.startsWith(dirs.agent)).toBe(true);
	expect(await fs.readFile(file, "utf8")).toContain('"title":"Bot"');
	const listed = (await page.evaluate(() => window.omp.sessions.list("global"))).filter(row => row.path === file);
	expect(listed).toHaveLength(1);
	const row = page.locator("[data-sidebar-bot-row]");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("Bot");
	await expect(page.locator(".omp-sidebar-session-row").first()).toHaveAttribute("data-sidebar-bot-row", "true");
	// It is not also a chat row, and nothing offers a menu or a delete for it.
	await expect(page.locator(`[data-session-path="${file}"]`)).toHaveCount(1);
	await expect(row.locator("[data-sidebar-row-menu]")).toHaveCount(0);
	await row.click({ button: "right" });
	await expect(page.getByRole("menu")).toHaveCount(0);

	// The owner's own session (no opener): the one whose question the bot answers.
	const owner = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	expect(owner).not.toBe("");
	// What the bot's omp was told about the owner's session (the fake records each `agent_control.mail`).
	const reports = async (kind: string) =>
		(await readRecords(record)).filter(frame => {
			const details = frame.details as Record<string, unknown> | undefined;
			return frame.type === "agent_control.mail" && details?.kind === kind && details?.from === owner;
		});

	// The owner's session shows a tool approval; the card wakes the bot (no tab of it yet) with one question report.
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture approval" }), owner);
	await expect.poll(async () => (await reports("question")).length, { timeout: 60_000 }).toBe(1);
	const [question] = await reports("question");
	expect(question).toMatchObject({ triggerTurn: true, deliverAs: "aside" });
	expect(String(question?.content)).toContain(`ompdesk_session_answer {"session":"${owner}","request":"approval"}`);
	const bot = await tabOf(file);
	expect(bot).not.toBe(owner);
	await expect.poll(() => lastAnswer(bot), { timeout: 30_000 }).toBe(`Read the question report from ${owner}.`);

	// Its answer reaches the card in the owner's omp.
	const answered = await callAs(bot, "ompdesk_session_answer", {
		session: owner,
		request: "approval",
		choice: "Deny",
	});
	expect(answered.isError, answered.text).toBe(false);
	await expect
		.poll(async () =>
			(await readRecords(record)).some(frame => frame.type === "extension_ui_response" && frame.id === "approval"),
		)
		.toBe(true);

	// The owner's finished turn is reported without a turn: the bot's last answer stays the one above.
	await expect.poll(async () => (await reports("done")).length, { timeout: 30_000 }).toBe(1);
	expect((await reports("done"))[0]?.triggerTurn).toBe(false);
	expect(await lastAnswer(bot)).toBe(`Read the question report from ${owner}.`);
});

test("a relaunch keeps the same bot session; a deleted one is made again, by a launch or a click on the row", async () => {
	test.setTimeout(150_000);
	const file = await botFile();
	await exitApp(app);
	await start();
	expect(await botFile()).toBe(file);
	const bots = async () =>
		(await page.evaluate(() => window.omp.sessions.list("global"))).filter(row => row.title === "Bot");
	expect(await bots()).toHaveLength(1);

	// Deleted through any path (e.g. `/delete`), the row still shows; a click asks main, which makes a new one and opens it.
	await page.evaluate(path => window.omp.sessions.delete(path), file);
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveCount(1);
	await page.locator("[data-sidebar-bot-row]").click();
	await expect.poll(async () => (await bots()).length).toBe(1);
	const next = (await bots())[0]?.path ?? "";
	expect(next).not.toBe(file);
	expect(await botFile()).toBe(next);
	await tabOf(next);
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveAttribute("data-active", "true");
});
