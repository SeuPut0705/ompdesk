import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, readRecords } from "./harness";

// OMPdesk control tools (src/main/agent-control): the main agent's host tools open a session, message it, wait for
// it and read it back; and refuse what needs the user without the confirmation card. The fake
// omp calls a tool with `fixture:host-tool:<name> <json>` (the way stock's agent would) and records the
// `host_tool_result` it gets. Subagents never have the tools: stock registers host tools on the RPC session only
// (checked against a real omp in real-agent-control.e2e.ts).

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let errors: string[];
let main: string;

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-control-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, batchNotifications: false }),
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
	main = (await tabs()).find(tab => tab.active)?.tabId ?? "";
	expect(main).not.toBe("");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

function tabs() {
	return page.evaluate(() => window.omp.tabs.list());
}

async function fixtureCommand(tabId: string, line: string): Promise<void> {
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, line] as const,
	);
	expect(response).toMatchObject({ success: true });
}

async function results(): Promise<{ text: string; isError: boolean }[]> {
	const frames = await readRecords(record);
	return frames
		.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
		.map(frame => {
			const result = frame.result as { content?: { text?: string }[] } | undefined;
			return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
		});
}

/** The main agent calls a control tool; resolves with the result text the agent gets back. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
	const before = (await results()).length;
	await fixtureCommand(main, `fixture:host-tool:${name} ${JSON.stringify(args)}`);
	await expect.poll(async () => (await results()).length, { timeout: 90_000 }).toBe(before + 1);
	return (await results())[before] as { text: string; isError: boolean };
}

test("create a session, send it a message, wait for it and read its result", async () => {
	test.setTimeout(150_000);
	const listed = await call("ompdesk_sessions");
	expect(listed.isError).toBe(false);
	expect(listed.text).toContain("1 session in this window");

	const opened = await call("ompdesk_session_open", { message: "Summarize the repo", show: "background" });
	expect(opened.isError).toBe(false);
	const child = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
	expect(child).not.toBe("");
	expect((await tabs()).map(tab => tab.tabId)).toContain(child);
	// The user's view stays where it was.
	expect((await tabs()).find(tab => tab.active)?.tabId).toBe(main);

	const first = await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
	expect(first.isError).toBe(false);
	expect(first.text).toContain("idle");
	expect(first.text).toContain("Local fixture reply");

	const sent = await call("ompdesk_session_send", { session: child, message: "Now list the risks" });
	expect(sent.text).toContain("Sent to");
	const second = await call("ompdesk_session_result", { sessions: [child], wait: true, timeout_seconds: 60 });
	expect(second.text).toContain("Local fixture reply");

	const read = await call("ompdesk_session_read", { session: child });
	expect(read.isError).toBe(false);
	expect(read.text).toContain("[user, sent by an agent");
	expect(read.text).toContain("Now list the risks");
	expect(read.text).toContain("[assistant] Local fixture reply");

	// The receiving session shows who sent it.
	const shown = await call("ompdesk_tab_focus", { session: child });
	expect(shown.isError).toBe(false);
	await expect.poll(async () => (await tabs()).find(tab => tab.active)?.tabId).toBe(child);
	await expect(page.getByText("Sent by an agent", { exact: false }).first()).toBeVisible();
	await expect(page.getByText("Now list the risks").first()).toBeVisible();
	await expect(page.getByText("ompdesk-agent-message")).toHaveCount(0);
});

test("with full control off, deleting a session the agent did not open needs the user's confirmation card; a refusal stops nothing", async () => {
	test.setTimeout(150_000);
	// Settings › Tools & extensions › "Give agents full control of OMPdesk" off, as the person would store it.
	await page.evaluate(() => window.omp.prefs.set("agentControlFull", false));
	// A second tab the user opened (⌘T): not the agent's.
	const before = (await tabs()).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
	const theirs = (await tabs()).find(tab => !before.includes(tab.tabId))?.tabId ?? "";
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === theirs)?.status).toBe("ready");
	// The main agent asks; its card waits on the main tab, which the sidebar marks "Needs input".

	const pending = call("ompdesk_session_stop", { session: theirs, delete: true });
	await page
		.getByRole("button", { name: /Needs input/ })
		.first()
		.click({ timeout: 30_000 });
	await expect(page.getByText("[OMPdesk]").first()).toBeVisible({ timeout: 30_000 });
	await page.getByRole("button", { name: /^Deny/ }).first().click();
	const declined = await pending;
	expect(declined.text).toContain("The user declined");
	expect((await tabs()).map(tab => tab.tabId)).toContain(theirs);

	const approved = call("ompdesk_session_stop", { session: theirs, delete: true });
	await page
		.getByRole("button", { name: /Needs input/ })
		.first()
		.click({ timeout: 30_000 });
	await expect(page.getByText("[OMPdesk]").first()).toBeVisible({ timeout: 30_000 });
	await page
		.getByRole("button", { name: /^Approve/ })
		.first()
		.click();
	// Approved, the delete runs (a ⌘T tab has no saved file yet, so main says closing is enough).
	expect((await approved).text).toMatch(/Stopped, closed and deleted|no saved file yet/);
});

test("by default (full control) the agent deletes a session it did not open with no card", async () => {
	test.setTimeout(150_000);
	const before = (await tabs()).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
	const theirs = (await tabs()).find(tab => !before.includes(tab.tabId))?.tabId ?? "";
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === theirs)?.status).toBe("ready");
	const result = await call("ompdesk_session_stop", { session: theirs, delete: true });
	expect(result.text).toMatch(/Stopped, closed and deleted|no saved file yet/);
	await expect(page.getByText("[OMPdesk]")).toHaveCount(0);
});

/** A plan-mode child that proposed its plan, shown so its card is on screen. */
async function proposingChild(): Promise<string> {
	const opened = await call("ompdesk_session_open", { message: "Plan the rollout", mode: "plan", show: "background" });
	const child = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
	expect(child).not.toBe("");
	await call("ompdesk_session_result", { session: child, wait: true, timeout_seconds: 60 });
	await fixtureCommand(child, "fixture:plan");
	await call("ompdesk_tab_focus", { session: child });
	await expect(page.getByText("Fixture rollout plan").first()).toBeVisible({ timeout: 30_000 });
	const listed = await call("ompdesk_sessions", { status: "waiting" });
	expect(listed.text).toContain(child);
	expect(listed.text).toContain('waiting for plan approval: "Fixture rollout plan"');
	return child;
}

test("the main agent approves a child's plan: the card closes and the child leaves plan mode", async () => {
	test.setTimeout(150_000);
	const child = await proposingChild();
	const answered = await call("ompdesk_session_answer", { session: child, approve: true, choice: "keep_context" });
	expect(answered.isError).toBe(false);
	expect(answered.text).toContain("approved plan");
	await expect(page.getByText("Fixture rollout plan")).toHaveCount(0, { timeout: 30_000 });
	const state = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), child);
	expect(state).toMatchObject({ data: { planModeEnabled: false } });
	expect((await call("ompdesk_sessions", { status: "waiting" })).text).not.toContain(child);
});

test("a plain message to a child whose plan waits replies to it and closes the card", async () => {
	test.setTimeout(150_000);
	const child = await proposingChild();
	expect((await call("ompdesk_session_send", { session: child, message: "Split step 2 in two" })).text).toContain(
		"Sent to",
	);
	await expect(page.getByText("Fixture rollout plan")).toHaveCount(0, { timeout: 30_000 });
	expect((await call("ompdesk_sessions", { status: "waiting" })).text).not.toContain(child);
});
