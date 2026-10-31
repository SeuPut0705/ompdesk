import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { exitApp, launchApp, readRecords } from "./harness";

// The secretary (src/main/agent-control/secretary.ts): the session the owner named answers, for them, the question
// card of a session they run. The card wakes it with a report (the fake omp's `agent_control.mail` runs a turn whose
// reply names the report), its answer through the control tools reaches the card, and the session's finished turn is
// then reported without waking it. Which sessions and kinds count is unit-tested in secretary.test.ts.

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let errors: string[];

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-secretary-"));
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
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: record, OMP_GUI_TEST_SESSION_FILES: "1" },
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

async function sessionPathOf(tabId: string): Promise<string> {
	let found = "";
	await expect
		.poll(async () => {
			const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tabId);
			found = tab?.sessionPath ?? "";
			return found;
		})
		.not.toBe("");
	return found;
}

test("the secretary is woken by another session's question card, answers it, and hears of its finish quietly", async () => {
	test.setTimeout(150_000);
	// The owner's own session (no opener): the one whose question the secretary answers.
	const owner = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const opened = await callAs(owner, "ompdesk_session_open", { message: "Title: secretary\nStand by." });
	const secretary = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
	expect(secretary, opened.text).not.toBe("");
	// The person writes to it, as to any session they keep: it never closes by itself.
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), secretary);
	await expect.poll(() => lastAnswer(secretary), { timeout: 30_000 }).not.toBe("");
	const secretaryPath = await sessionPathOf(secretary);
	await page.evaluate(file => window.omp.prefs.set("sidebar", { secretary: file }), secretaryPath);
	// What the secretary's omp was told about the owner's session (the fake records each `agent_control.mail`).
	const reports = async (kind: string) =>
		(await readRecords(record)).filter(frame => {
			const details = frame.details as Record<string, unknown> | undefined;
			return frame.type === "agent_control.mail" && details?.kind === kind && details?.from === owner;
		});

	// The owner's session shows a tool approval; the card wakes the secretary with one question report from it.
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture approval" }), owner);
	await expect.poll(async () => (await reports("question")).length, { timeout: 30_000 }).toBe(1);
	const [question] = await reports("question");
	expect(question).toMatchObject({ triggerTurn: true, deliverAs: "aside" });
	expect(String(question?.content)).toContain(`ompdesk_session_answer {"session":"${owner}","request":"approval"}`);
	await expect.poll(() => lastAnswer(secretary), { timeout: 30_000 }).toBe(`Read the question report from ${owner}.`);

	// Its answer reaches the card in the owner's omp.
	const answered = await callAs(secretary, "ompdesk_session_answer", {
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

	// The owner's finished turn is reported without a turn: the secretary's last answer stays the one above.
	await expect.poll(async () => (await reports("done")).length, { timeout: 30_000 }).toBe(1);
	expect((await reports("done"))[0]?.triggerTurn).toBe(false);
	expect(await lastAnswer(secretary)).toBe(`Read the question report from ${owner}.`);
});
