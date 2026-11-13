import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, readRecords, untilAnswered } from "./harness";

// A message to a session inside a blocking control-tool wait (src/main/agent-control, rule control-tools › Mailbox).
// 13 Nov 2026: a session sent another a steer whose receipt said it reads it between steps, while that one stood in
// `ompdesk_session_result {wait: true}`; stock's host tool call cannot be cut by a steer, so it read the message 50
// minutes later. The fake omp stands inside a host tool call (`fixture blocking tool:<name> <json>`) and reads the
// steers queued meanwhile once the result arrives.

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let errors: string[];
let main: string;

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-wait-wake-"));
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
	main = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	expect(main).not.toBe("");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

/** Every control-tool result any fake omp recorded so far, in order. */
async function results(): Promise<string[]> {
	return (await readRecords(record))
		.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
		.map(frame => (frame.result as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text ?? "");
}

/** The main agent calls a control tool; the first new result `match` reads (another session's call may end meanwhile). */
async function call(name: string, args: Record<string, unknown>, match: RegExp): Promise<string> {
	const seen = (await results()).length;
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[main, `fixture:host-tool:${name} ${JSON.stringify(args)}`] as const,
	);
	expect(response).toMatchObject({ success: true });
	const found = async () => (await results()).slice(seen).find(text => match.test(text));
	await expect.poll(found, { timeout: 90_000 }).toBeDefined();
	return (await found()) ?? "";
}

const status = async (tabId: string) =>
	(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status;

/** `ompdesk_session_open` with `message`; the new session's id. */
async function open(message: string): Promise<string> {
	const opened = await call("ompdesk_session_open", { message, show: "background" }, /Opened session/);
	return /Opened session (\w+)/.exec(opened)?.[1] ?? "";
}

test("a steer to a session in a blocking wait ends the wait, and the session reads the steer at once", async () => {
	test.setTimeout(180_000);
	// C works until told otherwise, so B's wait on it has no reason to end by itself.
	const busy = await open("Title: busy C\nWork on C");
	await untilAnswered(page, busy);
	await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }), busy);
	await expect.poll(() => status(busy)).toBe("running");

	// B stands inside `ompdesk_session_result {wait: true}` on C, for up to two minutes.
	const waiter = await open("Title: waiter B\nWait for C");
	await untilAnswered(page, waiter);
	const wait = JSON.stringify({ session: busy, wait: true, timeout_seconds: 120 });
	const started = await page.evaluate(
		([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }),
		[waiter, `fixture blocking tool:ompdesk_session_result ${wait}`] as const,
	);
	expect(started).toMatchObject({ success: true });
	await expect.poll(() => status(waiter)).toBe("running");
	// Nothing shows that main has taken B's call; a moment of real time covers the few milliseconds it needs.
	await page.waitForTimeout(1_000);

	// A (main) sends B a steer: the receipt says B's wait returns now, and B's wait does return, saying so.
	const receipt = await call("ompdesk_session_send", { session: waiter, message: "Read this now" }, /Sent to/);
	expect(receipt).toContain("inside a blocking ompdesk_session_result wait");
	await expect
		.poll(async () => (await results()).some(text => text.includes("Returned early")), { timeout: 30_000 })
		.toBe(true);

	// B read the steer in the same turn, after its tool returned, and answered it.
	const readsSteer = async () => {
		const read = await call("ompdesk_session_read", { session: waiter }, /\[(user|assistant)/);
		return read.includes("Read this now") && read.includes("Read the steer after the tool returned");
	};
	await expect.poll(readsSteer, { timeout: 30_000 }).toBe(true);
});
