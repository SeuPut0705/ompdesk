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
		env: {
			OMP_GUI_HEADLESS: "1",
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_SESSION_FILES: "1",
			OMP_GUI_TEST_SCHEDULE_TICK_MS: "100",
			OMP_GUI_TEST_SCHEDULE_MINUTE_MS: "200",
			OMP_GUI_TEST_AGENT_SWEEP_MS: "500",
		},
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

/** A command to the tab's omp is refused until it has started. */
async function untilReady(tabId: string): Promise<void> {
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status, {
			timeout: 30_000,
		})
		.toBe("ready");
}

// The bot's role (agent-control/bot.ts `role`, gui-bridge agent-control.ts `ompdesk-bot`): its omp is told the owner's
// action rules, and `ompdesk_schedule {target: "self"}` puts a wake-up in the Schedules service that main delivers
// into the bot's own session as a mail that starts a turn. The launch shortens the schedule clock
// (`OMP_GUI_TEST_SCHEDULE_TICK_MS`, `OMP_GUI_TEST_SCHEDULE_MINUTE_MS`: five minutes pass in a second) and the sweep.
test("the bot's omp hears the owner's rules, and a check it schedules for itself wakes its own turn", async () => {
	test.setTimeout(180_000);
	const file = await botFile();
	await page.locator("[data-sidebar-bot-row]").click();
	const bot = await tabOf(file);
	await untilReady(bot);

	// Told the default rules (the bridge turns them into the `ompdesk-bot` prompt section), once for this tab.
	const told = async () => (await readRecords(record)).filter(frame => frame.type === "agent_control.bot");
	await expect.poll(async () => (await told()).length, { timeout: 30_000 }).toBe(1);
	expect(String((await told())[0]?.rules)).toContain("- Deploy or release: ask the owner before taking it.");
	expect(String((await told())[0]?.rules)).toContain("- Edit code: take it without asking.");

	const made = await callAs(bot, "ompdesk_schedule", {
		action: "create",
		target: "self",
		name: "check the build",
		prompt: "Check the build; tell the owner only if it failed",
		every_minutes: 5,
	});
	expect(made.isError, made.text).toBe(false);
	expect(made.text).toContain("it wakes this session");
	const id = /id ([\w-]+);/.exec(made.text)?.[1] ?? "";
	expect(id).not.toBe("");

	// It is in the Schedules panel's list like any schedule, marked as the agent's.
	const state = () => page.evaluate(() => window.omp.schedules.command({ action: "get" }));
	expect((await state()).schedules.find(schedule => schedule.id === id)).toMatchObject({
		name: "[agent] check the build",
		wakeSession: file,
	});

	// A moment later main delivers its prompt into the bot's own session; the fake omp runs a turn on the mail.
	const wakes = async () =>
		(await readRecords(record)).filter(frame => {
			const details = frame.details as Record<string, unknown> | undefined;
			return frame.type === "agent_control.mail" && details?.from === "ompdesk" && details?.kind === "note";
		});
	await expect.poll(async () => (await wakes()).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
	const [wake] = await wakes();
	expect(wake).toMatchObject({ triggerTurn: true, deliverAs: "aside" });
	expect(String(wake?.content)).toContain("Check the build; tell the owner only if it failed");
	await expect.poll(() => lastAnswer(bot), { timeout: 30_000 }).toBe("Read the note report from ompdesk.");

	// The run is recorded as a success, no omp -p was started for it, and the agent that made it can cancel it.
	await expect
		.poll(async () => (await state()).runs.find(run => run.scheduleId === id)?.status, { timeout: 30_000 })
		.toBe("succeeded");
	const cancelled = await callAs(bot, "ompdesk_schedule", { action: "cancel", id });
	expect(cancelled.isError, cancelled.text).toBe(false);
	expect((await state()).schedules.some(schedule => schedule.id === id)).toBe(false);
	// Told once: the later mails did not repeat the rules.
	expect(await told()).toHaveLength(1);
});

test("a session the bot opens shows under the bot row, and nowhere else in the lists", async () => {
	test.setTimeout(180_000);
	const file = await botFile();
	await page.locator("[data-sidebar-bot-row]").click();
	const bot = await tabOf(file);
	await untilReady(bot);

	// The child waits on a question card, so its row stays (a finished one that landed clean leaves every family). It
	// is opened with no brief and the owner types the prompt that raises the card: an agent's own brief is wrapped, which
	// the fake omp does not take for that prompt.
	const opened = await callAs(bot, "ompdesk_session_open", { show: "background" });
	expect(opened.isError, opened.text).toBe(false);
	const child = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
	expect(child).not.toBe("");
	await untilReady(child);
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture approval" }), child);
	let childFile = "";
	await expect
		.poll(async () => {
			childFile =
				(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.sessionPath ?? "";
			return childFile;
		})
		.not.toBe("");

	const nested = page.locator(`[data-sidebar-family="${file}"] [data-sidebar-opened-session]`);
	await expect(nested).toHaveCount(1, { timeout: 60_000 });
	await expect(nested).toHaveAttribute("data-session-path", childFile);
	await expect(nested).toHaveAttribute("data-child-status", "waiting");
	// It is that row alone: no project or chat row repeats it, and the bot's own row is still the one fixed row.
	await expect(page.locator(`[data-session-path="${childFile}"]`)).toHaveCount(1);
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveCount(1);
	await expect(page.locator(".omp-sidebar-session-row").first()).toHaveAttribute("data-sidebar-bot-row", "true");
});
