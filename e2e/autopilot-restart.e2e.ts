/**
 * Autopilot across an OMPdesk crash (SIGKILL, no hook runs) or a normal quit, the pattern of interrupted-resume.e2e.ts on
 * the fake omp: the run lives in the session journal (the fake's session file), so a relaunch restores it. The fake
 * does what stock does when OMPdesk goes away mid-turn (fixture/autopilot.ts): the turn is journaled aborted with no
 * `session_exit`, the next process pauses the goal and remembers its startup tool set. A run continues by itself after
 * any restart, armed with its own tools, whether a cycle was running (TurnResume's marker) or not; only with "Continue
 * interrupted work" off does it show paused:app_closed with a Resume button. A release in flight is still marked after
 * the restart, and the agent's next `begin` says so before anything else.
 */
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import {
	type ApProfile,
	activeTools,
	agentTools,
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
	status,
	survivors,
	waitForRunTab,
	waitForStatus,
} from "./autopilot-harness";
import { exitApp, fixtureOmp } from "./harness";

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
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${profile.desktop}`],
		env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page };
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

test("a normal quit while a cycle runs: the next launch continues the run by itself", async () => {
	test.setTimeout(240_000);
	const profile = await makeApProfile({ script: { cycleMs: 6_000 } });
	const { app, page } = await launchAp(profile);
	let current: ElectronApplication | undefined = app;
	try {
		const tabId = await startRun(page, await mainTab(page));
		await waitForStatus(page, tabId, s => s.now?.n === 1, "cycle 1 is running", 60_000);
		await expect.poll(() => markers(profile.desktop), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
		await expect.poll(() => layoutSessions(profile.desktop), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

		// Continue interrupted work is on, so the quit should ask nothing; were it to ask, "Quit anyway" is the answer.
		await app.evaluate(({ app: electronApp, dialog }) => {
			dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
			setImmediate(() => electronApp.quit());
		});
		const child = app.process();
		await new Promise<void>(resolve => {
			if (child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once("exit", () => resolve());
		});
		current = undefined;
		await expect
			.poll(() => survivors(profile.root), { timeout: 20_000, message: "the quit app's children must end" })
			.toEqual([]);

		const second = await relaunch(profile);
		current = second.app;
		const restored = await waitForRunTab(second.page);
		// The cut cycle runs again to its record under the resumed run.
		await waitForStatus(
			second.page,
			restored.tabId,
			s => (s.cycles?.length ?? 0) >= 1 && s.state === "running",
			"the run goes on after the quit",
			90_000,
		);
		const arms = (await recorded(profile, "fixture_autopilot_session")).filter(entry => entry.action === "arm");
		expect(arms.at(-1)).toMatchObject({ resume: true, role: "parent" });
		expectArmedTools(await activeTools(second.page, restored.tabId));
	} finally {
		if (current) await exitApp(current);
		await cleanupAp(profile);
	}
});

test("a kill between turns leaves no marker, and the run still goes on by itself", async () => {
	test.setTimeout(240_000);
	// Stock continues a goal at once; a long gap stands for the moment between two turns.
	const profile = await makeApProfile({ script: { cycleMs: 400, gapMs: 120_000 } });
	const { app, page } = await launchAp(profile);
	let current: ElectronApplication = app;
	try {
		const tabId = await startRun(page, await mainTab(page));
		await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) === 1, "cycle 1 is done", 60_000);
		await expect.poll(() => markers(profile.desktop), { timeout: 30_000 }).toEqual([]);
		await expect.poll(() => layoutSessions(profile.desktop), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

		const second = await crashAndRelaunch(profile, app);
		current = second.app;
		const restored = await waitForRunTab(second.page);
		// A restored tab nobody has shown stays asleep; opening it is what starts its omp (and the run's check).
		await second.page.evaluate(id => window.omp.tabs.setActive(id), restored.tabId);
		// The resume starts the next cycle at once (stock's continuation after `goal resume`): cycle 1 kept, then 2.
		const resumed = await waitForStatus(
			second.page,
			restored.tabId,
			s => (s.cycles?.length ?? 0) >= 2,
			"cycle 2 after the restart",
			60_000,
		);
		expect(resumed.cycles?.map(cycle => cycle.n)).toEqual([1, 2]);
		expect(resumed.state).toBe("running");
		expectArmedTools(await activeTools(second.page, restored.tabId));
	} finally {
		await exitApp(current);
		await cleanupAp(profile);
	}
});

test("with Continue interrupted work off, a killed run is paused as app_closed and Resume continues it", async () => {
	test.setTimeout(240_000);
	const profile = await makeApProfile({
		prefs: { resumeInterrupted: false },
		script: { cycleMs: 400, gapMs: 120_000 },
	});
	const { app, page } = await launchAp(profile);
	let current: ElectronApplication = app;
	try {
		const tabId = await startRun(page, await mainTab(page));
		await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) === 1, "cycle 1 is done", 60_000);
		await expect.poll(() => layoutSessions(profile.desktop), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

		const second = await crashAndRelaunch(profile, app);
		current = second.app;
		const restored = await waitForRunTab(second.page);
		await second.page.evaluate(id => window.omp.tabs.setActive(id), restored.tabId);
		const paused = await waitForStatus(
			second.page,
			restored.tabId,
			s => s.state === "paused",
			"paused after the restart",
			60_000,
		);
		expect(paused.reason).toBe("app_closed");
		expect(paused.cycles?.length).toBe(1);
		// No turn started by itself.
		expect((await agentTools(profile)).filter(entry => entry.op === "begin").length).toBe(1);

		// Resume (the screen's button sends the same command): cycle 1 is kept, the next one is cycle 2.
		expect(await setAutopilot(second.page, restored.tabId, { action: "resume" })).toMatchObject({ success: true });
		const resumed = await waitForStatus(
			second.page,
			restored.tabId,
			s => (s.cycles?.length ?? 0) >= 2,
			"cycle 2 after Resume",
			60_000,
		);
		expect(resumed.cycles?.map(cycle => cycle.n)).toEqual([1, 2]);
	} finally {
		await exitApp(current);
		await cleanupAp(profile);
	}
});

test("a release in flight is still marked after a crash, and the agent's next begin reports it first", async () => {
	test.setTimeout(240_000);
	const profile = await makeApProfile({
		releaseProcedure: true,
		script: {
			cycleMs: 400,
			cycles: { "2": { release: { version: "v1.0.0", holdMs: 120_000, tools: [] } } },
		},
	});
	const { app, page } = await launchAp(profile);
	let current: ElectronApplication = app;
	try {
		const tabId = await startRun(page, await mainTab(page), {
			ship: { autoPush: false, autoRelease: { on: true, cadence: { kind: "every", n: 1 } } },
		});
		await waitForStatus(page, tabId, s => s.ship?.inFlight?.kind === "release", "a release is in flight", 90_000);
		await expect.poll(() => markers(profile.desktop), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
		await expect.poll(() => layoutSessions(profile.desktop), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

		const second = await crashAndRelaunch(profile, app);
		current = second.app;
		const restored = await waitForRunTab(second.page);
		await waitForStatus(second.page, restored.tabId, s => s.state === "running", "the run is back", 90_000);
		// The journal kept the mark through the restart.
		expect((await status(second.page, restored.tabId)).ship?.inFlight).toMatchObject({ kind: "release" });
		// The resumed cycle's `begin` hands the agent the mark before it does anything else.
		await expect
			.poll(
				async () =>
					(await agentTools(profile))
						.filter(entry => entry.op === "begin")
						.some(entry => {
							const result = entry.result as { ship?: { inFlight?: { kind?: string } } } | undefined;
							return result?.ship?.inFlight?.kind === "release";
						}),
				{ timeout: 60_000 },
			)
			.toBe(true);
	} finally {
		await exitApp(current);
		await cleanupAp(profile);
	}
});
