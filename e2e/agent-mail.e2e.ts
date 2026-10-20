import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp, readRecords } from "./harness";
import { launchRemote, makeRemoteProfile } from "./remote-harness";

// Sessions tell each other things (src/main/agent-control/mail.ts): a parent opens two children; each reports
// (`ompdesk_report`) and finishes, one asks a question first, the parent answers it, and the parent reacts to every
// done and question by itself: no polling tool is called. The fake omp's `agent_control.mail` journals the report as
// a displayed `ompdesk.mail` custom message and, for a report that wakes the receiver, runs a turn whose reply names
// it. The delivery rules, coalescing, stale dispatches and receipts are unit-tested in service.test.ts.

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-mail-"));
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
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: record },
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
	expect(errors).toEqual([]);
});

async function toolResults(): Promise<{ by: string; text: string; isError: boolean }[]> {
	return (await readRecords(record))
		.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
		.map(frame => {
			const result = frame.result as { content?: { text?: string }[] } | undefined;
			return {
				by: String(frame.recordedBy),
				text: result?.content?.[0]?.text ?? "",
				isError: frame.isError === true,
			};
		});
}

/** The main agent of `tabId` calls a control tool; resolves with the result it gets back. */
async function callAs(
	tabId: string,
	name: string,
	args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
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

test("children report, one asks and is answered, and the parent reacts to each without polling", async () => {
	test.setTimeout(150_000);
	const parent = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const opened = await callAs(parent, "ompdesk_session_open", {
		sessions: [{ message: "Title: part A\nDo A" }, { message: "Title: part B\nDo B" }],
	});
	expect(opened.isError, opened.text).toBe(false);
	expect(opened.text).toContain("end your turn and you are woken");
	const [a, b] = [...opened.text.matchAll(/Opened session (\w+)/g)].map(match => match[1] as string);
	await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(3);

	// A asks; the question reaches the parent between its steps and wakes it.
	const asked = await callAs(a as string, "ompdesk_report", {
		kind: "question",
		text: "Keep the old API?",
		dispatch: "d1",
	});
	expect(asked.text).toMatch(/Wait for the answer/);
	await expect.poll(() => lastAnswer(parent), { timeout: 30_000 }).toBe(`Read the question report from ${a}.`);
	// The parent answers through the existing send; A gets dispatch d2 with it.
	const answered = await callAs(parent, "ompdesk_session_send", {
		session: a,
		message: "Keep it.",
		request_id: "answer-1",
	});
	expect(answered.text).toMatch(/accepted.*Dispatch d2/);
	const repeat = await callAs(parent, "ompdesk_session_send", {
		session: a,
		message: "Keep it.",
		request_id: "answer-1",
	});
	expect(repeat.text).toMatch(/nothing sent again/);
	// A report for the old dispatch no longer counts.
	expect((await callAs(a as string, "ompdesk_report", { kind: "done", text: "old", dispatch: "d1" })).text).toMatch(
		/Ignored/,
	);

	// Both finish; each done wakes the parent by itself.
	await callAs(a as string, "ompdesk_report", {
		kind: "done",
		text: "A finished, old API kept",
		files: ["src/a.ts"],
		checks: [{ command: "bun test", passed: true }],
		dispatch: "d2",
	});
	await expect.poll(() => lastAnswer(parent), { timeout: 30_000 }).toBe(`Read the done report from ${a}.`);
	await callAs(b as string, "ompdesk_report", { kind: "done", text: "B finished", dispatch: "d1" });
	await expect.poll(() => lastAnswer(parent), { timeout: 30_000 }).toBe(`Read the done report from ${b}.`);

	// The parent never polled: no result wait and no session list was called.
	const called = (await toolResults()).map(result => result.text);
	expect(called.some(text => text.startsWith("Still running") || /session[s]? in this window/.test(text))).toBe(false);
	// The reports show in the parent's transcript as quiet lines: a question open, a done closed until pressed.
	await page.evaluate(id => window.omp.tabs.setActive(id), parent);
	await expect(page.locator("[data-agent-mail='question']").first()).toContainText("Keep the old API?", {
		timeout: 30_000,
	});
	const doneA = page.locator("[data-agent-mail='done']").first();
	await expect(doneA).toBeVisible();
	await expect(page.getByText("A finished, old API kept")).toHaveCount(0);
	await doneA.locator("button[aria-expanded]").press("Enter");
	await expect(page.getByText("A finished, old API kept")).toBeVisible();
});

test("a progress report shows without a prompt: at once to an idle parent, waiting then landing for a busy one", async () => {
	test.setTimeout(120_000);
	const parent = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const opened = await callAs(parent, "ompdesk_session_open", { message: "Title: part A\nDo A" });
	const child = /Opened session (\w+)/.exec(opened.text)?.[1] as string;
	await page.evaluate(id => window.omp.tabs.setActive(id), parent);
	const landed = page.locator("[data-agent-mail='progress']");
	const waiting = page.locator("[data-agent-mail-pending='progress']");

	// Idle parent: the report is in the transcript once main's 2 s progress window closes, with no prompt sent.
	await callAs(child, "ompdesk_report", { kind: "progress", text: "idle step", dispatch: "d1" });
	await expect(landed).toHaveCount(1, { timeout: 2_000 + 1_000 });

	// Busy parent: the report waits in view while the turn runs and lands in the transcript once it ends.
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }), parent);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === parent)?.status)
		.toBe("running");
	await callAs(child, "ompdesk_report", { kind: "progress", text: "busy step", dispatch: "d1" });
	await expect(waiting).toContainText("shows when this turn ends", { timeout: 2_000 + 1_000 });
	await expect(landed).toHaveCount(1);
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:finish" }), parent);
	await expect(landed).toHaveCount(2, { timeout: 1_000 });
	await expect(waiting).toHaveCount(0);
	// Nobody sent the parent a prompt: its only user message is the one that started the turn.
	const transcript = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "get_transcript_page", fromEnd: true, limit: 50 }),
		parent,
	);
	const roles = ((transcript.data as { messages?: { role?: string }[] } | undefined)?.messages ?? []).map(m => m.role);
	expect(roles.filter(role => role === "user")).toHaveLength(1);
});

test("a report repeated after a relaunch arrives once: the receiver's journal is the record", async () => {
	test.setTimeout(180_000);
	// This test runs its own two launches on a saved layout; the beforeEach app is not used.
	await exitApp(app);
	const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-mail-relaunch-"));
	const relaunchProfile = await makeRemoteProfile(parentDir, "one", {
		language: "en",
		theme: "light",
	});
	record = relaunchProfile.record;
	try {
		let instance = await launchRemote(relaunchProfile);
		page = instance.page;
		const parent = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		const opened = await callAs(parent, "ompdesk_session_open", { message: "Title: part A\nDo A" });
		const child = /Opened session (\w+)/.exec(opened.text)?.[1] as string;
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.sessionPath,
			)
			.toBeTruthy();
		await callAs(child, "ompdesk_report", { kind: "done", text: "A finished", dispatch: "d1" });
		await expect.poll(() => lastAnswer(parent), { timeout: 30_000 }).toBe(`Read the done report from ${child}.`);
		await exitApp(instance.app);

		// Relaunch: the saved layout brings both tabs back under new ids; the child's call runs again (as stock re-runs
		// a call whose result the crash lost) and reaches the parent's omp, which already journaled it.
		instance = await launchRemote(relaunchProfile, { project: false });
		page = instance.page;
		app = instance.app;
		const tabs = await page.evaluate(() => window.omp.tabs.list());
		const again = tabs.find(tab => tab.openedBySession !== undefined)?.tabId ?? "";
		const parentAgain = tabs.find(tab => tab.tabId !== again)?.tabId ?? "";
		expect(again && parentAgain).toBeTruthy();
		await page.evaluate(id => window.omp.tabs.setActive(id), again);
		await expect
			.poll(
				async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === again)?.status,
				{ timeout: 60_000 },
			)
			.toBe("ready");
		await page.evaluate(id => window.omp.tabs.setActive(id), parentAgain);
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === parentAgain)?.status,
				{ timeout: 60_000 },
			)
			.toBe("ready");
		const repeated = await callAs(again, "ompdesk_report", { kind: "done", text: "A finished", dispatch: "d1" });
		expect(repeated.isError, repeated.text).toBe(false);
		const page_ = await page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "get_transcript_page", fromEnd: true, limit: 50 }),
			parentAgain,
		);
		const messages = ((page_.data as { messages?: { customType?: string }[] } | undefined)?.messages ?? []).filter(
			message => message.customType === "ompdesk.mail",
		);
		expect(messages).toHaveLength(1);
	} finally {
		await fs.rm(parentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
