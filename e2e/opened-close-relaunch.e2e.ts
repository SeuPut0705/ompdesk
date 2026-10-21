/**
 * A session an agent opened that finished before a relaunch closes by itself after it (src/main/agent-control:
 * `autoClose`; host.ts reads the opener from the restored tab layout). Before, the opener a launch saw lived only in
 * memory: a child restored by a relaunch (a new tab id, often a deferred tab nothing started) never closed and stayed
 * on the work board's "Opened sessions" list for good. Fake omp with stock-shaped session files; the opener's turn
 * runs through the quit, so nothing collects the child's answer before it. Unit cases: host.test.ts ("restored after
 * a relaunch"), service.test.ts (asleep, started, paired host, done report).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { cssString, exitApp, fixtureOmp, readRecords } from "./harness";

interface Profile {
	root: string;
	desktop: string;
	record: string;
	env: Record<string, string>;
}

async function makeProfile(): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-opened-relaunch-")));
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
		OMP_GUI_TEST_AGENT_SWEEP_MS: "500",
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
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1600, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page };
}

/** A normal quit (Continue interrupted work is on, so it asks nothing). */
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

/** The opener's agent calls a control tool (the fake omp's `fixture:host-tool`); resolves with its result. */
async function call(profile: Profile, page: Page, opener: string, name: string, args: Record<string, unknown>) {
	const results = async () => (await readRecords(profile.record)).filter(frame => frame.type === "host_tool_result");
	const before = (await results()).length;
	const line = `fixture:host-tool:${name} ${JSON.stringify(args)}`;
	await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [opener, line]);
	await expect.poll(async () => (await results()).length, { timeout: 60_000 }).toBe(before + 1);
	return (await results())[before];
}

test("a finished child restored by a relaunch leaves the open list by itself and stays gone", async () => {
	test.setTimeout(240_000);
	const profile = await makeProfile();
	let current: ElectronApplication | undefined;
	try {
		const first = await launch(profile);
		current = first.app;
		const opener = (await tabs(first.page)).find(tab => tab.active)?.tabId ?? "";
		// The opener's turn runs through the quit: nothing reads the child's answer before the relaunch.
		await first.page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running with job" }),
			opener,
		);
		await expect.poll(async () => (await tabs(first.page)).find(tab => tab.tabId === opener)?.status).toBe("running");
		await call(profile, first.page, opener, "ompdesk_session_open", {
			message: "Title: plain task\nfixture:result-ok",
		});
		const child = async (page: Page) => (await tabs(page)).find(tab => tab.tabId !== opener && tab.openedBySession);
		await expect.poll(async () => (await child(first.page))?.lastRun?.stopReason, { timeout: 60_000 }).toBe("stop");
		const childPath = (await child(first.page))?.sessionPath ?? "";
		expect(childPath).not.toBe("");
		await quit(first.app);
		current = undefined;

		const second = await launch(profile);
		current = second.app;
		// The relaunch continues the opener's cut-off turn; once that turn has run and ended (the opener has nothing
		// running that could still read the answer) the restored child leaves by itself. The opener reading it first
		// and the continuing opener holding it are pinned by service.test.ts ("waits while …").
		await expect
			.poll(async () => (await tabs(second.page)).some(tab => tab.sessionPath === childPath), { timeout: 15_000 })
			.toBe(false);
		// The work board folds it into its "1 done" row: no open row is left for it; unfolded, it is a done row.
		const fold = second.page.locator("[data-board-opened-done]");
		await expect(fold).toHaveText("1 done", { timeout: 15_000 });
		await expect(second.page.locator("[data-board-opened]")).toHaveCount(0);
		await fold.click();
		const row = second.page.locator(`[data-board-opened=${cssString(childPath)}]`);
		await expect(row).toHaveAttribute("data-status", "done");
		await quit(second.app);
		current = undefined;

		const third = await launch(profile);
		current = third.app;
		expect((await tabs(third.page)).some(tab => tab.sessionPath === childPath)).toBe(false);
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
