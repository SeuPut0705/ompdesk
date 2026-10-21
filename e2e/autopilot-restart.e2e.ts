/**
 * Autopilot across an OMPdesk crash (SIGKILL, no hook runs) and across an automatic update restart, the pattern of
 * interrupted-resume.e2e.ts on the fake omp: the run lives in the session journal (the fake's session file), so a
 * relaunch restores it. The fake does what stock does when OMPdesk goes away mid-turn (fixture/autopilot.ts): the turn
 * is journaled aborted with no `session_exit`, the next process pauses the goal and remembers its startup tool set,
 * and the run continues by itself, armed with its own tools. The other restart rules (a normal quit, a kill between
 * turns, "Continue interrupted work" off with its Resume, a release marked in flight) are unit-tested in
 * src/main/autopilot.test.ts ("restart") and src/main/bridge-autopilot-core.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import {
	type ApProfile,
	activeTools,
	cleanupAp,
	crash,
	expectArmedTools,
	launchAp,
	layoutSessions,
	mainTab,
	makeApProfile,
	markers,
	recorded,
	setAutopilot,
	startRun,
	waitForRunTab,
	waitForStatus,
} from "./autopilot-harness";
import { stagedUpdateEnv } from "./fixture/stand-in-bundle";
import { exitApp, fixtureOmp } from "./harness";
import { survivors } from "./process-tree";

/** Relaunch on the profile's userData with no argv cwd, so the saved layout (the run's tab) is restored. */
async function relaunch(profile: ApProfile): Promise<{ app: ElectronApplication; page: Page }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({
		...process.env,
		PI_CODING_AGENT_DIR: profile.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile.root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile.root),
		...profile.env,
	})) {
		if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
	}
	const app = await electron.launch({
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${profile.desktop}`],
		env,
	});
	// What main printed, for a relaunch that never shows a window (nightly 39510409009: none within 30 s after a kill).
	const output: string[] = [];
	for (const stream of [app.process().stdout, app.process().stderr])
		stream?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await page.waitForFunction(() => window.omp?.rpc != null);
		return { app, page };
	} catch (error) {
		const runtime = await fs
			.readFile(path.join(profile.desktop, "logs", "gui-runtime.jsonl"), "utf8")
			.catch(() => "(no runtime log)");
		await test.info().attach("relaunch-main-output.txt", { body: output.join("") || "(nothing)" });
		await test.info().attach("relaunch-runtime-log.txt", { body: runtime.split("\n").slice(-60).join("\n") });
		await exitApp(app);
		throw error;
	}
}

async function crashAndRelaunch(profile: ApProfile, app: ElectronApplication) {
	await crash(app);
	await expect
		.poll(() => survivors(profile.root), { timeout: 20_000, message: "the killed app's children must end" })
		.toEqual([]);
	return relaunch(profile);
}

test("a cycle running when OMPdesk is killed resumes by itself on the next launch", async () => {
	test.setTimeout(240_000);
	const profile = await makeApProfile({ script: { cycleMs: 6_000 } });
	const { app, page } = await launchAp(profile);
	let current: ElectronApplication = app;
	try {
		const tabId = await startRun(page, await mainTab(page));
		await waitForStatus(
			page,
			tabId,
			s => (s.cycles?.length ?? 0) >= 1 && s.now?.n === 2,
			"cycle 2 is running",
			90_000,
		);
		await expect.poll(() => markers(profile.desktop), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
		await expect.poll(() => layoutSessions(profile.desktop), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
		const armsBefore = (await recorded(profile, "fixture_autopilot_session")).filter(
			entry => entry.action === "arm",
		).length;

		const second = await crashAndRelaunch(profile, app);
		current = second.app;
		const restored = await waitForRunTab(second.page);
		// The marker brought it back: armed again with `resume`, the goal resumed, and cycle 2 ran to its record.
		const run = await waitForStatus(
			second.page,
			restored.tabId,
			s => (s.cycles?.length ?? 0) >= 2 && s.state === "running",
			"the run resumed",
			90_000,
		);
		expect(run.cycles?.map(cycle => cycle.n).slice(0, 2)).toEqual([1, 2]);
		const arms = (await recorded(profile, "fixture_autopilot_session")).filter(entry => entry.action === "arm");
		expect(arms.length).toBe(armsBefore + 1);
		expect(arms.at(-1)).toMatchObject({ resume: true, role: "parent" });
		expect((await recorded(profile, "goal")).map(entry => entry.op)).toContain("resume");
		// The new omp holds the run's own tool set, and so does what stock gives back when the run pauses: its
		// `goal resume` puts back the set it remembered, which must not be the startup one (ask, eval, debug).
		expectArmedTools(await activeTools(second.page, restored.tabId));
		expect(await setAutopilot(second.page, restored.tabId, { action: "pause" })).toMatchObject({ success: true });
		await waitForStatus(second.page, restored.tabId, s => s.state === "paused", "paused by the user", 30_000);
		expectArmedTools(await activeTools(second.page, restored.tabId));
	} finally {
		await exitApp(current);
		await cleanupAp(profile);
	}
});

test("a cycle running when an automatic update installs resumes after the relaunch", async () => {
	test.skip(process.platform !== "darwin", "The relaunch install mode is macOS's");
	test.setTimeout(240_000);
	// The switch starts off so the run can start before the staged update is offered; turning it on is the default.
	const profile = await makeApProfile({ script: { cycleMs: 6_000 }, prefs: { appAutoUpdate: false } });
	const update = await stagedUpdateEnv(profile.root, profile.desktop, "99.0.0", 2_000);
	const { app, page } = await launchAp({ ...profile, env: { ...profile.env, ...update.env } });
	let current: ElectronApplication = app;
	try {
		const tabId = await startRun(page, await mainTab(page));
		await waitForStatus(
			page,
			tabId,
			s => (s.cycles?.length ?? 0) >= 1 && s.now?.n === 2,
			"cycle 2 is running",
			90_000,
		);
		await expect.poll(() => markers(profile.desktop), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
		await expect.poll(() => layoutSessions(profile.desktop), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
		const { promise: exited, resolve: onExit } = Promise.withResolvers<void>();
		app.process().once("exit", () => onExit());
		// A running turn holds nothing back: with Continue interrupted work on the update installs at once.
		await page.evaluate(() => window.omp.prefs.set("appAutoUpdate", true));
		await exited;
		await expect
			.poll(() => fs.readFile(update.swapLog, "utf8").catch(() => ""), { timeout: 30_000 })
			.toContain("installed");
		const log = await fs.readFile(path.join(profile.desktop, "logs", "gui-runtime.jsonl"), "utf8");
		expect(log).toMatch(/"event":"safe"[^\n]*"running":true/);
		expect(log).toMatch(/"event":"install","trigger":"auto"/);
		expect(await markers(profile.desktop)).toMatchObject([{ reason: "running" }]);

		// What the swap's relaunch opens is this app again, without the staged update.
		const second = await relaunch(profile);
		current = second.app;
		const restored = await waitForRunTab(second.page);
		const run = await waitForStatus(
			second.page,
			restored.tabId,
			s => (s.cycles?.length ?? 0) >= 2 && s.state === "running",
			"the run resumed",
			90_000,
		);
		expect(run.cycles?.map(cycle => cycle.n).slice(0, 2)).toEqual([1, 2]);
		const arms = (await recorded(profile, "fixture_autopilot_session")).filter(entry => entry.action === "arm");
		expect(arms.at(-1)).toMatchObject({ resume: true, role: "parent" });
	} finally {
		await exitApp(current);
		await cleanupAp(profile);
	}
});
