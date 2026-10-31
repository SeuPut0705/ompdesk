import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { type FakeImap, startFakeImap } from "../src/main/routines/fake-imap";
import { cssString, exitApp, launchApp, mailReports, pressShortcutUntilVisible, readRecords } from "./harness";

// The bot (src/main/agent-control/bot.ts, kept by bot-home.ts): off on a fresh install; once the owner turns it on
// (pref `botEnabled`, Settings › Bot; bot-rules.e2e.ts clicks the switch) it has one bot row at the top of
// the sidebar and its session. It answers only the sessions it opened: a question card of the owner's own session never
// reaches it, one of a session the bot opened does (the fake omp's `agent_control.mail` runs a turn whose reply names
// the report), and its answer through the control tools reaches the card. Which sessions count is unit-tested in
// bot.test.ts, and the keeping of the session in bot-home.test.ts.

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
			// Email routines reach the spec's fake IMAP server over plain TCP and poll it every 300 ms.
			OMP_GUI_TEST_IMAP_PLAIN: "1",
			OMP_GUI_TEST_EMAIL_POLL_MS: "300",
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
		JSON.stringify({ language: "en", firstRunComplete: true, botEnabled: true }),
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

test("with the bot on, the app has the bot row and its session, and only its own sessions' questions reach it", async () => {
	test.setTimeout(180_000);
	// Nothing else was set up: main made the bot's session (titled, listed) and the sidebar's first row is the bot.
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
	await expect(page.locator(`[data-session-path=${cssString(file)}]`)).toHaveCount(1);
	await expect(row.locator("[data-sidebar-row-menu]")).toHaveCount(0);
	await row.click({ button: "right" });
	await expect(page.getByRole("menu")).toHaveCount(0);

	// The owner's own session (no opener) shows a tool approval: the owner answers it, the bot never hears of it.
	const owner = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	expect(owner).not.toBe("");
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture approval" }), owner);
	await expect(page.locator("[data-prompt-card]")).toBeVisible({ timeout: 60_000 });
	const questionsFrom = (tabId: string) =>
		mailReports(record, details => details.kind === "question" && details.from === tabId);

	// A session the bot opened shows one: that question comes to the bot.
	await row.click();
	const bot = await tabOf(file);
	await untilReady(bot);
	const opened = await callAs(bot, "ompdesk_session_open", { show: "background" });
	expect(opened.isError, opened.text).toBe(false);
	const child = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
	expect(child).not.toBe("");
	await untilReady(child);
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture approval" }), child);
	await expect.poll(async () => (await questionsFrom(child)).length, { timeout: 60_000 }).toBe(1);
	const [question] = await questionsFrom(child);
	expect(question).toMatchObject({ triggerTurn: true, deliverAs: "aside" });
	// The owner's question came first and still went to nobody.
	expect(await questionsFrom(owner)).toEqual([]);
	await expect.poll(() => lastAnswer(bot), { timeout: 30_000 }).toBe(`Read the question report from ${child}.`);

	// Its answer reaches the card in the child's omp.
	const answered = await callAs(bot, "ompdesk_session_answer", {
		session: child,
		request: "approval",
		choice: "Deny",
	});
	expect(answered.isError, answered.text).toBe(false);
	await expect
		.poll(async () =>
			(await readRecords(record)).some(frame => frame.type === "extension_ui_response" && frame.id === "approval"),
		)
		.toBe(true);
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
	expect(String((await told())[0]?.rules)).toContain("- Make payments or purchases: ask the owner before taking it.");
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

	// The run follows the turn the wake started and is recorded as a success when it ends (starts that came due while it
	// ran are skipped); no omp -p was started for it, and the agent that made it can cancel it.
	await expect
		.poll(
			async () =>
				(await state()).runs.some(
					run => run.scheduleId === id && run.status === "succeeded" && run.endedAt !== null,
				),
			{ timeout: 30_000 },
		)
		.toBe(true);
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

	const nested = page.locator(`[data-sidebar-family=${cssString(file)}] [data-sidebar-opened-session]`);
	await expect(nested).toHaveCount(1, { timeout: 60_000 });
	await expect(nested).toHaveAttribute("data-session-path", childFile);
	await expect(nested).toHaveAttribute("data-child-status", "waiting");
	// It is that row alone: no project or chat row repeats it, and the bot's own row is still the one fixed row.
	await expect(page.locator(`[data-session-path=${cssString(childFile)}]`)).toHaveCount(1);
	await expect(page.locator("[data-sidebar-bot-row]")).toHaveCount(1);
	await expect(page.locator(".omp-sidebar-session-row").first()).toHaveAttribute("data-sidebar-bot-row", "true");
});

/** The window's screenshot, attached to the report; `OMPDESK_BOT_SHOTS=<dir>` also keeps it there. */
async function capture(name: string): Promise<void> {
	const body = await page.screenshot({ animations: "disabled" });
	await test.info().attach(name, { body, contentType: "image/png" });
	const dir = process.env.OMPDESK_BOT_SHOTS;
	if (dir) {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, `${name}.png`), body);
	}
}

async function windowWidth(width: number): Promise<void> {
	await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size, 860), width);
}

test("the bot's desk: a decision and a duty it posts show around its conversation and on its row, and the owner's answer reaches it", async () => {
	test.setTimeout(180_000);
	await windowWidth(1440);
	const file = await botFile();
	await page.locator("[data-sidebar-bot-row]").click();
	const bot = await tabOf(file);
	await untilReady(bot);
	// One screen: the bar over the conversation, no Home/Chat switch, the duties on the docked board.
	const pane = page.locator(`.omp-session-pane[data-tab-id="${bot}"]`);
	await expect(pane.locator("[data-bot-bar] [data-bot-state]")).toBeVisible();
	await expect(pane.locator(".omp-transcript-scroll")).toBeVisible();
	await expect(pane.getByRole("tablist")).toHaveCount(0);
	await expect(pane.locator('[data-board-section="duties"]')).toBeVisible();

	// Only the bot may use its desk tool.
	const owner = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.sessionPath !== file)?.tabId;
	if (owner) {
		const refused = await callAs(owner, "ompdesk_bot", { action: "desk" });
		expect(refused.isError).toBe(true);
	}

	const duty = await callAs(bot, "ompdesk_bot", { action: "duty_add", text: "Check the nightly build" });
	expect(duty.isError, duty.text).toBe(false);
	await expect(page.locator("[data-bot-duty]")).toContainText(["Check the nightly build"]);

	const posted = await callAs(bot, "ompdesk_bot", {
		action: "decide",
		question: "Ship the release today?",
		options: ["Ship it", "Wait"],
		operation: "gh release create v0.43.0 --target main",
		inputs: { version: "v0.43.0" },
		draft: "Release notes: faster bot.",
	});
	expect(posted.isError, posted.text).toBe(false);
	const id = /Decision (\S+) is posted/.exec(posted.text)?.[1] ?? "";
	expect(id).not.toBe("");
	// The inbox above the composer, the conversation still on screen, and the count on the bot's row.
	const card = page.locator("[data-bot-decision]");
	await expect(card).toHaveCount(1);
	await expect(card).toContainText("Ship the release today?");
	// The exact operation and its inputs, verbatim, and the draft the owner may edit before answering.
	await expect(card.locator("[data-bot-decision-operation]")).toHaveText("gh release create v0.43.0 --target main");
	await expect(card.locator("[data-bot-decision-inputs] dd")).toHaveText(["v0.43.0"]);
	await card.locator("[data-bot-decision-draft]").fill("Release notes: faster bot, one screen.");
	await expect(page.locator("[data-sidebar-bot-decisions]")).toHaveAttribute("data-sidebar-bot-decisions", "1");
	await expect(pane.locator(".omp-transcript-scroll")).toBeVisible();
	await capture("bot-wide");
	// Narrow: the board becomes the strip, whose panel holds the duties; the bar and the decisions stay.
	await windowWidth(760);
	await expect(pane.locator("[data-work-chip]")).toBeVisible();
	await expect(pane.locator("[data-bot-bar] [data-bot-next-wake]")).toBeVisible();
	await expect(card.locator('[data-bot-option="Ship it"]')).toBeVisible();
	await capture("bot-narrow");
	await pane.locator("[data-work-chip]").click();
	await pane.locator('[data-board-section="duties"] .omp-work-board-fold').click();
	await expect(pane.locator("[data-bot-duty]")).toContainText(["Check the nightly build"]);
	await capture("bot-narrow-strip");
	await pane.locator("[data-work-chip]").click();
	await windowWidth(1440);

	// The owner answers in place: the card leaves, the count goes, and the bot's omp gets the answer as a turn.
	await card.locator('[data-bot-option="Ship it"]').click();
	await expect(card).toHaveCount(0);
	await expect(page.locator("[data-sidebar-bot-decisions]")).toHaveCount(0);
	const answers = () => mailReports(record, details => details.id === `bot-decision-${id}`);
	await expect.poll(async () => (await answers()).length, { timeout: 30_000 }).toBe(1);
	const [answer] = await answers();
	expect(answer).toMatchObject({ triggerTurn: true, deliverAs: "aside" });
	expect(String(answer?.content)).toContain("Answer: Ship it");
	expect(String(answer?.content)).toContain("Operation: gh release create v0.43.0 --target main");
	expect(String(answer?.content)).toContain("Draft as the owner approved it:\nRelease notes: faster bot, one screen.");

	// The duty outlives the app: a relaunch reads the same desk.
	await exitApp(app);
	await start();
	await windowWidth(1440);
	await page.locator("[data-sidebar-bot-row]").click();
	await expect(page.locator("[data-bot-duty]")).toContainText(["Check the nightly build"]);
	await expect(page.locator("[data-bot-answered]")).toBeVisible();
});

test("the bot's tasks, library and pause: its sessions in progress and done by the owner's mark, held while paused", async () => {
	test.setTimeout(240_000);
	await windowWidth(1440);
	const file = await botFile();
	await page.locator("[data-sidebar-bot-row]").click();
	const bot = await tabOf(file);
	await untilReady(bot);
	const pane = page.locator(`.omp-session-pane[data-tab-id="${bot}"]`);
	const tasks = pane.locator('[data-board-section="tasks"]');
	await expect(tasks).toBeVisible();

	// One session waits on its approval card, another finishes: both are the bot's tasks, in progress.
	const open = async (prompt: string): Promise<{ tab: string; file: string }> => {
		const opened = await callAs(bot, "ompdesk_session_open", { show: "background" });
		expect(opened.isError, opened.text).toBe(false);
		const tab = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
		await untilReady(tab);
		await page.evaluate(([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }), [
			tab,
			prompt,
		] as const);
		let path = "";
		await expect
			.poll(async () => {
				path =
					(await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tab)?.sessionPath ??
					"";
				return path;
			})
			.not.toBe("");
		return { tab, file: path };
	};
	const waiting = await open("fixture approval");
	const finished = await open("hello");
	await expect(tasks.locator(`[data-bot-task=${cssString(waiting.file)}]`)).toHaveAttribute(
		"data-task-state",
		"needs",
		{
			timeout: 60_000,
		},
	);
	const done = tasks.locator(`[data-bot-task=${cssString(finished.file)}]`);
	await expect(done).toHaveAttribute("data-task-state", "review", { timeout: 60_000 });
	await capture("bot-tasks-wide");

	// Only the owner completes it: the mark moves it to Completed, kept on the desk across a relaunch.
	await done.locator('[data-bot-task-mark="done"]').click();
	await expect(done).toHaveAttribute("data-task-state", "done");
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sessions.botDesk.get())).tasksDone)
		.toEqual([finished.file]);

	// Pause: the bar says so, the desk keeps it, and an answer to a decision waits until Resume.
	await pane.locator('[data-bot-pause="running"]').click();
	await expect(pane.locator('[data-bot-status-line="paused"]')).toBeVisible();
	const posted = await callAs(bot, "ompdesk_bot", {
		action: "decide",
		question: "Rerun the nightly?",
		options: ["Yes"],
	});
	const id = /Decision (\S+) is posted/.exec(posted.text)?.[1] ?? "";
	await pane.locator('[data-bot-decision] [data-bot-option="Yes"]').click();
	await expect(pane.locator("[data-bot-decision]")).toHaveCount(0);
	const answers = () => mailReports(record, details => details.id === `bot-decision-${id}`);
	// Held while paused: the outbox keeps it (main's host.test.ts pins the holding); the bot's omp hears it on Resume.
	await capture("bot-paused-wide");
	expect(await answers()).toHaveLength(0);
	await pane.locator("[data-bot-resume]").click();
	await expect(pane.locator('[data-bot-status-line="paused"]')).toHaveCount(0);
	await expect.poll(async () => (await answers()).length, { timeout: 30_000 }).toBe(1);

	// Narrow: the strip's panel holds the same tasks.
	await windowWidth(760);
	await expect(pane.locator("[data-work-chip]")).toBeVisible();
	await pane.locator("[data-work-chip]").click();
	await pane.locator('[data-board-section="tasks"] .omp-work-board-fold').click();
	await expect(pane.locator(`[data-bot-task=${cssString(waiting.file)}]`)).toBeVisible();
	await capture("bot-tasks-narrow");
});

// The bot's routines (schedules that wake its own session; src/main/schedules.ts, BotRoutines.tsx): asked for in chat,
// the bot makes one with `ompdesk_schedule {target: "self"}` (an event routine and a once follow-up here); the owner
// sees them on its board, tests one, and the run follows the bot's turn to its end into the run history.
test("the bot's routines: made in chat, listed on its board, tested by the owner, with the run in their history", async () => {
	test.setTimeout(180_000);
	await windowWidth(1440);
	const file = await botFile();
	await page.locator("[data-sidebar-bot-row]").click();
	const bot = await tabOf(file);
	await untilReady(bot);
	const pane = page.locator(`.omp-session-pane[data-tab-id="${bot}"]`);

	const watch = await callAs(bot, "ompdesk_schedule", {
		action: "create",
		target: "self",
		name: "CI watch",
		prompt: "Look at the failed session and tell the owner why",
		on: { source: "session", events: ["failed"] },
	});
	expect(watch.isError, watch.text).toBe(false);
	expect(watch.text).toContain("it waits for its event");
	const id = /id ([\w-]+);/.exec(watch.text)?.[1] ?? "";
	const followUp = await callAs(bot, "ompdesk_schedule", {
		action: "create",
		target: "self",
		name: "check back",
		prompt: "See whether the release went out",
		in_minutes: 30,
	});
	expect(followUp.isError, followUp.text).toBe(false);

	const routines = pane.locator("[data-bot-routine]");
	await expect(routines).toHaveCount(2);
	const row = pane.locator(`[data-bot-routine="${id}"]`);
	await expect(row).toContainText("CI watch");
	await expect(row).toContainText("When a session fails a turn");
	await row.click();
	await pane.locator("[data-bot-routine-test]").click();
	// The test run wakes the bot (the fake omp runs a turn on the mail) and ends with that turn.
	const run = pane.locator('[data-bot-routine-run][data-status="succeeded"]');
	await expect(run).toHaveCount(1, { timeout: 60_000 });
	await expect(run).toContainText("Test");
	await expect.poll(() => lastAnswer(bot), { timeout: 30_000 }).toBe("Read the note report from ompdesk.");
	const history = await callAs(bot, "ompdesk_schedule", { action: "runs", id });
	expect(history.text).toContain("succeeded (test)");
	await capture("routines-wide");

	// Narrow: the board is the strip's panel, and the routines section is there.
	await windowWidth(760);
	await pane.locator("[data-work-chip]").click();
	await pane.locator('[data-board-section="routines"] .omp-work-board-fold').click();
	await expect(pane.locator(`[data-bot-routine="${id}"]`)).toBeVisible();
	await capture("routines-narrow");
	await pane.locator("[data-work-chip]").click();
	await windowWidth(1440);

	// The owner pauses it from the board: the schedule is off in the service too.
	await pane.locator(`[data-bot-routine="${id}"]`).click();
	if ((await pane.locator("[data-bot-routine-toggle]").count()) === 0)
		await pane.locator(`[data-bot-routine="${id}"]`).click();
	await pane.locator("[data-bot-routine-toggle]").click();
	await expect
		.poll(
			async () =>
				(await page.evaluate(() => window.omp.schedules.command({ action: "get" }))).schedules.find(
					schedule => schedule.id === id,
				)?.enabled,
		)
		.toBe(false);
	expect(errors).toEqual([]);
});

// An email routine (src/main/routines/email.ts): the owner adds a mailbox in Settings › Schedules (the password typed
// once, kept by the OS keystore), the bot makes a routine on it, and new mail to the plus-address wakes the bot with
// the mail's sender, subject and text; mail to the plain address does not.
test("an email routine: the owner adds a mailbox in Settings, and new mail to the bot's address wakes the bot", async () => {
	test.setTimeout(180_000);
	const imap: FakeImap = await startFakeImap();
	try {
		await windowWidth(1440);
		const file = await botFile();
		await page.locator("[data-sidebar-bot-row]").click();
		const bot = await tabOf(file);
		await untilReady(bot);

		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="schedules"]').click();
		await settings.locator("[data-mail-account-new]").click();
		const form = page.locator("[data-mail-account-form]");
		await form.getByLabel("Label").fill("Work");
		await form.getByLabel("Server").fill("127.0.0.1");
		await form.getByLabel("Port").fill(String(imap.port));
		await form.getByLabel("Username").fill(imap.state.user);
		await form.getByLabel("Password").fill(imap.state.password);
		await page.getByRole("dialog").getByRole("button", { name: "Add", exact: true }).click();
		const account = settings.locator("[data-mail-account]").filter({ hasText: "Work" });
		await expect(account).toBeVisible();
		imap.mail.push({ uid: 1, headers: "From: old@example.com\r\nSubject: already there" });
		await account.locator("[data-mail-test]").click();
		await expect(account.locator("[data-mail-test-result]")).toContainText("Mailbox opened: 1 message");
		await capture("mail-account-settings");
		// The password never comes back to a window.
		const listed = await page.evaluate(() => window.omp.mailAccounts.command({ action: "list" }));
		expect(JSON.stringify(listed)).not.toContain(imap.state.password);
		await page.keyboard.press("Escape");

		const made = await callAs(bot, "ompdesk_schedule", {
			action: "create",
			target: "self",
			name: "bot mail",
			prompt: "Answer what the owner mailed you",
			on: { source: "email", account: "Work", to: "owner+bot@" },
		});
		expect(made.isError, made.text).toBe(false);
		const id = /id ([\w-]+);/.exec(made.text)?.[1] ?? "";
		// The trigger takes its baseline first (the mail already there never fires), then mail arrives.
		await expect.poll(() => imap.commands.filter(line => / EXAMINE /.test(line)).length).toBeGreaterThanOrEqual(2);
		imap.mail.push(
			{ uid: 2, headers: "From: Ann <ann@example.com>\r\nTo: owner@example.com\r\nSubject: not for the bot" },
			{
				uid: 3,
				headers: "From: Owner <owner@example.com>\r\nTo: owner+bot@example.com\r\nSubject: Rerun the nightly",
				body: "Please rerun it tonight.",
			},
		);
		const wakes = () =>
			mailReports(record, details => typeof details.id === "string" && details.id.startsWith("wake-"));
		await expect.poll(async () => (await wakes()).length, { timeout: 60_000 }).toBe(1);
		const [wake] = await wakes();
		expect(String(wake?.content)).toContain(
			'New mail in Work from Owner <owner@example.com> to owner+bot@example.com: "Rerun the nightly"',
		);
		expect(String(wake?.content)).toContain("Please rerun it tonight.");
		expect(String(wake?.content)).not.toContain("not for the bot");
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.omp.schedules.command({ action: "get" }))).runs.find(
						run => run.scheduleId === id && run.trigger === "event",
					)?.status,
			)
			.toBe("succeeded");
		expect(errors).toEqual([]);
	} finally {
		await imap.close();
	}
});

// A routine's trigger keeps where it stood across a relaunch (src/main/routines/marks.ts, `<userData>/routine-marks.json`):
// a git routine of the bot's, made while OMPdesk runs, wakes the bot once on the next launch for the commit made while
// OMPdesk was closed.
test("a git routine fires once after a relaunch for the commit made while OMPdesk was closed", async () => {
	test.setTimeout(180_000);
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
	const repo = path.join(profile, "repo");
	await fs.mkdir(repo);
	git("init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-q", "-m", "First");
	const first = git("rev-parse", "HEAD");

	const file = await botFile();
	await page.locator("[data-sidebar-bot-row]").click();
	const bot = await tabOf(file);
	await untilReady(bot);
	const made = await callAs(bot, "ompdesk_schedule", {
		action: "create",
		target: "self",
		name: "watch main",
		prompt: "Review what landed",
		on: { source: "git", repo, branch: "main" },
	});
	expect(made.isError, made.text).toBe(false);
	const id = /id ([\w-]+);/.exec(made.text)?.[1] ?? "";
	const marks = path.join(dirs.desktop, "routine-marks.json");
	const markOf = async () =>
		JSON.parse(await fs.readFile(marks, "utf8").catch(() => "{}")).marks?.[id]?.mark as { head?: string } | undefined;
	await expect.poll(markOf).toEqual({ head: first });

	await exitApp(app);
	await fs.writeFile(path.join(repo, "b.txt"), "two\n");
	git("add", ".");
	git("commit", "-q", "-m", "Landed while closed");
	const second = git("rev-parse", "HEAD");
	await start();

	const wakes = () => mailReports(record, details => typeof details.id === "string" && details.id.startsWith("wake-"));
	await expect.poll(async () => (await wakes()).length, { timeout: 60_000 }).toBe(1);
	expect(String((await wakes())[0]?.content)).toContain(
		`1 new commit on main: ${second.slice(0, 7)} Landed while closed`,
	);
	await expect.poll(markOf).toEqual({ head: second });
	await expect
		.poll(
			async () =>
				(await page.evaluate(() => window.omp.schedules.command({ action: "get" }))).runs.filter(
					run => run.scheduleId === id && run.trigger === "event",
				).length,
		)
		.toBe(1);
	expect(errors).toEqual([]);
});
