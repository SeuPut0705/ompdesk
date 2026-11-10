import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { type FakeImap, startFakeImap } from "../src/main/routines/fake-imap";
import {
	controlToolCaller,
	exitApp,
	launchApp,
	mailReports,
	pressShortcutUntilVisible,
	untilAnswered,
} from "./harness";

// A session's own routines on the fake omp: its agent calls `ompdesk_schedule {target: "self"}`, and main
// (ScheduleService's `wake` → AgentControlHost.wakeSession) delivers the prompt into that same session as a mail that
// starts a turn; the fake omp's `agent_control.mail` runs that turn and answers "Read the note report from ompdesk.".
// The launch shortens the schedule clock (`OMP_GUI_TEST_SCHEDULE_TICK_MS`, `OMP_GUI_TEST_SCHEDULE_MINUTE_MS`: five
// minutes pass in a second), reaches the spec's fake IMAP server over plain TCP (`OMP_GUI_TEST_IMAP_PLAIN`) and polls
// it every 300 ms (`OMP_GUI_TEST_EMAIL_POLL_MS`). The rest is unit-tested: the wake's delivery and its run's end in
// host.test.ts ("a session's own wake-up"), the service in schedules.test.ts, the sources in src/main/routines/*.test.ts
// (marks, git, email, imap, sessions, triggers), and the Settings rows in SchedulesSection.test.tsx and
// MailAccounts.test.tsx.

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
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-routines-"));
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

/** The person's own session: the first tab, after its first message (a wake needs its saved file). */
async function ownSession(): Promise<{ tab: string; file: string }> {
	const composer = page.locator('.omp-session-pane[data-active="true"] textarea');
	await composer.fill("Keep an eye on the build");
	await composer.press("Enter");
	const active = async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active);
	await expect.poll(async () => (await active())?.sessionPath ?? "").toMatch(/\.jsonl$/);
	const own = await active();
	const tab = own?.tabId ?? "";
	await untilAnswered(page, tab, { after: "Keep an eye on the build" });
	return { tab, file: own?.sessionPath ?? "" };
}

/** The schedule id an `ompdesk_schedule` create names. */
function scheduleId(text: string): string {
	const id = /id ([\w-]+);/.exec(text)?.[1] ?? "";
	expect(id, text).not.toBe("");
	return id;
}

/** Every wake main delivered (`wake-<run id>` mails), once each. */
function wakes() {
	return mailReports(record, details => typeof details.id === "string" && details.id.startsWith("wake-"));
}

function schedules() {
	return page.evaluate(() => window.omp.schedules.command({ action: "get" }));
}

const WOKEN = "Read the note report from ompdesk.";

test("a check a session schedules for itself wakes its own turn in its own tab", async () => {
	test.setTimeout(150_000);
	const own = await ownSession();
	const callAs = await controlToolCaller(page, record, own.tab);
	const made = await callAs("ompdesk_schedule", {
		action: "create",
		target: "self",
		name: "check the build",
		prompt: "Check the build; tell the owner only if it failed",
		every_minutes: 5,
	});
	expect(made.isError, made.text).toBe(false);
	expect(made.text).toContain("it wakes this session");
	const id = scheduleId(made.text);
	expect((await schedules()).schedules.find(schedule => schedule.id === id)).toMatchObject({
		name: "[agent] check the build",
		wakeSession: own.file,
	});

	await expect.poll(async () => (await wakes()).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
	const [wake] = await wakes();
	expect(wake).toMatchObject({ triggerTurn: true, deliverAs: "aside" });
	expect(String(wake?.content)).toContain("Check the build; tell the owner only if it failed");
	await untilAnswered(page, own.tab, { text: WOKEN });
	// No omp -p and no other tab: the run is the session's own turn, recorded as a success when it ends.
	expect(await page.evaluate(() => window.omp.tabs.list())).toHaveLength(1);
	await expect
		.poll(
			async () =>
				(await schedules()).runs.some(
					run => run.scheduleId === id && run.status === "succeeded" && run.endedAt !== null,
				),
			{ timeout: 30_000 },
		)
		.toBe(true);

	const cancelled = await callAs("ompdesk_schedule", { action: "cancel", id });
	expect(cancelled.isError, cancelled.text).toBe(false);
	expect((await schedules()).schedules.some(schedule => schedule.id === id)).toBe(false);
});

test("a session's routine made in chat is listed in Settings › Schedules, run by hand there, with the run in its history", async () => {
	test.setTimeout(150_000);
	const own = await ownSession();
	const callAs = await controlToolCaller(page, record, own.tab);
	const watch = await callAs("ompdesk_schedule", {
		action: "create",
		target: "self",
		name: "CI watch",
		prompt: "Look at the failed session and tell the owner why",
		on: { source: "session", events: ["failed"] },
	});
	expect(watch.isError, watch.text).toBe(false);
	expect(watch.text).toContain("it waits for its event");
	const id = scheduleId(watch.text);

	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="schedules"]').click();
	const row = settings.locator(`[data-schedule="${id}"]`);
	await expect(row).toContainText("[agent] CI watch");
	await expect(row).toContainText("When a session fails a turn");
	await row.locator("[data-schedule-run]").click();
	// The run wakes the session (the fake omp runs a turn on the mail) and ends with that turn.
	const run = settings.locator("[data-schedule-runs] [data-schedule-run-row]").filter({ hasText: "[agent] CI watch" });
	await expect(run).toHaveCount(1, { timeout: 60_000 });
	await expect(run).toContainText("run by hand");
	await expect(run).toContainText("Succeeded", { timeout: 60_000 });
	await untilAnswered(page, own.tab, { text: WOKEN });
	const history = await callAs("ompdesk_schedule", { action: "runs", id });
	expect(history.text).toContain("succeeded (test)");

	// The owner turns it off in its row: off in the service too.
	await row.getByRole("switch").click();
	await expect
		.poll(async () => (await schedules()).schedules.find(schedule => schedule.id === id)?.enabled)
		.toBe(false);
});

// An email routine (src/main/routines/email.ts): the owner adds a mailbox in Settings › Schedules (the password typed
// once, kept by the OS keystore), the session makes a routine on it, and new mail to the plus-address wakes the
// session with the mail's sender, subject and text; mail to the plain address does not.
test("an email routine: the owner adds a mailbox in Settings, and new mail to its address wakes the session", async () => {
	test.setTimeout(150_000);
	const imap: FakeImap = await startFakeImap();
	try {
		const own = await ownSession();
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
		// The password never comes back to a window.
		const listed = await page.evaluate(() => window.omp.mailAccounts.command({ action: "list" }));
		expect(JSON.stringify(listed)).not.toContain(imap.state.password);
		await page.keyboard.press("Escape");

		const callAs = await controlToolCaller(page, record, own.tab);
		const made = await callAs("ompdesk_schedule", {
			action: "create",
			target: "self",
			name: "ci mail",
			prompt: "Answer what the owner mailed you",
			on: { source: "email", account: "Work", to: "owner+ci@" },
		});
		expect(made.isError, made.text).toBe(false);
		const id = scheduleId(made.text);
		// The trigger takes its baseline first (the mail already there never fires), then mail arrives.
		await expect.poll(() => imap.commands.filter(line => / EXAMINE /.test(line)).length).toBeGreaterThanOrEqual(2);
		imap.mail.push(
			{ uid: 2, headers: "From: Ann <ann@example.com>\r\nTo: owner@example.com\r\nSubject: not for the routine" },
			{
				uid: 3,
				headers: "From: Owner <owner@example.com>\r\nTo: owner+ci@example.com\r\nSubject: Rerun the nightly",
				body: "Please rerun it tonight.",
			},
		);
		await expect.poll(async () => (await wakes()).length, { timeout: 60_000 }).toBe(1);
		const [wake] = await wakes();
		expect(String(wake?.content)).toContain(
			'New mail in Work from Owner <owner@example.com> to owner+ci@example.com: "Rerun the nightly"',
		);
		expect(String(wake?.content)).toContain("Please rerun it tonight.");
		expect(String(wake?.content)).not.toContain("not for the routine");
		await untilAnswered(page, own.tab, { text: WOKEN });
		await expect
			.poll(
				async () => (await schedules()).runs.find(run => run.scheduleId === id && run.trigger === "event")?.status,
			)
			.toBe("succeeded");
	} finally {
		await imap.close();
	}
});

// A routine's trigger keeps where it stood across a relaunch (src/main/routines/marks.ts, `<userData>/routine-marks.json`):
// a session's git routine, made while OMPdesk runs, wakes that session once on the next launch for the commit made
// while OMPdesk was closed.
test("a git routine fires once after a relaunch for the commit made while OMPdesk was closed", async () => {
	test.setTimeout(150_000);
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	const repo = path.join(profile, "repo");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
	await fs.mkdir(repo);
	git("init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-q", "-m", "First");
	const first = git("rev-parse", "HEAD");

	const own = await ownSession();
	const callAs = await controlToolCaller(page, record, own.tab);
	const made = await callAs("ompdesk_schedule", {
		action: "create",
		target: "self",
		name: "watch main",
		prompt: "Review what landed",
		on: { source: "git", repo, branch: "main" },
	});
	expect(made.isError, made.text).toBe(false);
	const id = scheduleId(made.text);
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

	const eventRuns = async () =>
		(await schedules()).runs.filter(run => run.scheduleId === id && run.trigger === "event");
	await expect
		.poll(async () => (await eventRuns()).map(run => run.status), { timeout: 60_000 })
		.toEqual(["succeeded"]);
	await expect.poll(markOf).toEqual({ head: second });
	const delivered = await wakes();
	expect(delivered).toHaveLength(1);
	expect(String(delivered[0]?.content)).toContain(`1 new commit on main: ${second.slice(0, 7)} Landed while closed`);
	// The woken turn is in the session's transcript, in whichever tab holds it after the relaunch.
	const holder = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.sessionPath === own.file);
	expect(holder).toBeDefined();
	await untilAnswered(page, holder?.tabId ?? "", { text: WOKEN });
});
