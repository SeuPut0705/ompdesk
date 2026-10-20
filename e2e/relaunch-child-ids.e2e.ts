/**
 * After a relaunch every restored tab has a new id, and a child an agent opened has no title of its own (stock names
 * only a person's first message; the GUI's `task` lived in memory). The opener's agent still holds the old id and
 * expects the child's name: `ompdesk_session_send` on the old id reaches the same session, and `ompdesk_sessions`
 * names it by the `Title:` line of its first message. Fake omp with stock-shaped session files. Unit cases:
 * service.test.ts ("after a relaunch"), sidecar-pool.test.ts ("earlier tab ids"), tab-layout.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, readRecords } from "./harness";

interface Profile {
	root: string;
	desktop: string;
	record: string;
	env: Record<string, string>;
}

async function makeProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-relaunch-ids-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, lastProject: project }),
	);
	const record = path.join(root, "rpc.jsonl");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_HEADLESS: "1",
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_TEST_RECORD: record,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, desktop, record, env };
}

/** No argv folder, so a relaunch restores the saved layout. */
async function launch(profile: Profile): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page };
}

async function quit(app: ElectronApplication): Promise<void> {
	const child = app.process();
	const exited = new Promise<void>(resolve => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once("exit", () => resolve());
	});
	await app.evaluate(({ app, dialog }) => {
		dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
		setImmediate(() => app.quit());
	});
	await exited;
}

const tabs = (page: Page) => page.evaluate(() => window.omp.tabs.list());

/** The opener's agent calls a control tool (the fake omp's `fixture:host-tool`); resolves with its result text. */
async function call(profile: Profile, page: Page, opener: string, name: string, args: Record<string, unknown>) {
	const results = async () => (await readRecords(profile.record)).filter(frame => frame.type === "host_tool_result");
	const before = (await results()).length;
	const line = `fixture:host-tool:${name} ${JSON.stringify(args)}`;
	await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [opener, line]);
	await expect.poll(async () => (await results()).length, { timeout: 60_000 }).toBe(before + 1);
	const frame = (await results())[before];
	const result = frame?.result;
	const first =
		result && typeof result === "object" && "content" in result && Array.isArray(result.content)
			? result.content[0]
			: undefined;
	const text =
		first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
	return { text, isError: frame?.isError === true };
}

/** A turn that keeps running (the fake omp's long turn), as an agent's does while it works with the control tools. */
async function busy(page: Page, tabId: string): Promise<void> {
	await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running with job" }),
		tabId,
	);
	await expect.poll(async () => (await tabs(page)).find(tab => tab.tabId === tabId)?.status).toBe("running");
}

test("an opened child keeps its id and its name through a relaunch", async () => {
	test.setTimeout(240_000);
	const profile = await makeProfile();
	let current: ElectronApplication | undefined;
	try {
		const first = await launch(profile);
		current = first.app;
		const opener = (await tabs(first.page)).find(tab => tab.active)?.tabId ?? "";
		await busy(first.page, opener);
		const opened = await call(profile, first.page, opener, "ompdesk_session_open", {
			message: "Title: Fix the parser\nparse.ts drops a field.",
		});
		const oldId = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
		expect(oldId).not.toBe("");
		const child = async (page: Page, id: string) => (await tabs(page)).find(tab => tab.tabId === id);
		await expect
			.poll(async () => (await child(first.page, oldId))?.lastRun?.stopReason, { timeout: 60_000 })
			.toBe("stop");
		const childPath = (await child(first.page, oldId))?.sessionPath ?? "";
		expect(childPath).not.toBe("");
		await quit(first.app);
		current = undefined;

		const second = await launch(profile);
		current = second.app;
		const restored = (await tabs(second.page)).find(tab => tab.sessionPath === childPath);
		expect(restored?.tabId).toBeDefined();
		expect(restored?.tabId).not.toBe(oldId);
		const boss = (await tabs(second.page)).find(tab => tab.active)?.tabId ?? "";

		const listed = await call(profile, second.page, boss, "ompdesk_sessions", {});
		expect(listed.text).toContain(`${restored?.tabId} "Fix the parser"`);
		expect(listed.text).not.toContain(`${restored?.tabId} (untitled`);

		const sent = await call(profile, second.page, boss, "ompdesk_session_send", {
			session: oldId,
			message: "carry on",
		});
		expect(sent.isError).toBe(false);
		expect(sent.text).toContain('Sent to "Fix the parser"');
		// The pool knows the name too, so every window shows it.
		await expect.poll(async () => (await child(second.page, restored?.tabId ?? ""))?.task).toBe("Fix the parser");
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a busy child that reports learns of the follow-up queued behind its turn, and the next send steers", async () => {
	test.setTimeout(180_000);
	const profile = await makeProfile();
	let current: ElectronApplication | undefined;
	try {
		const { app, page } = await launch(profile);
		current = app;
		const opener = (await tabs(page)).find(tab => tab.active)?.tabId ?? "";
		await busy(page, opener);
		const opened = await call(profile, page, opener, "ompdesk_session_open", { message: "Title: part A\nDo A" });
		const kid = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
		await expect
			.poll(async () => (await tabs(page)).find(tab => tab.tabId === kid)?.lastRun?.stopReason)
			.toBe("stop");
		// The child's next turn keeps running (the fake omp's long turn), as a worker's does while it works.
		await busy(page, kid);

		const queued = await call(profile, page, opener, "ompdesk_session_send", { session: kid, message: "Also do C" });
		expect(queued.text).toContain("queued as a follow-up");
		expect(queued.text).toContain("Dispatch d2");

		// The child reports and would wait in the same turn: stock shows it no queued follow-up, so the report says so.
		const report = await call(profile, page, kid, "ompdesk_report", { kind: "done", text: "A done", dispatch: "d2" });
		expect(report.isError).toBe(false);
		expect(report.text).toContain("(dispatch d2) waits for you");
		expect(report.text).toContain("end your turn now");

		const next = await call(profile, page, opener, "ompdesk_session_send", { session: kid, message: "And D" });
		expect(next.text).toContain("delivered as steer (it already reported to you in this turn");
		const prompts = (await readRecords(profile.record)).filter(
			frame => frame.type === "prompt" && typeof frame.message === "string" && frame.message.includes("And D"),
		);
		expect(prompts.at(-1)?.streamingBehavior).toBe("steer");
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
