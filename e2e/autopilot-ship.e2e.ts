/**
 * Autopilot's shipping on the fake omp with a local bare remote: "local only" (the agent's `git push` is blocked and
 * nothing reaches the remote), the automatic push after a green cycle (only the autopilot branch, never after a red
 * one, never `main`), release detection and the release path (a fake gate script and a fake `gh`, the run url
 * polled), a failing gate or run (paused:release_failed), "push now" in chat (a forged quote is refused), and the
 * screen's Push / PR / merge / revert queue run at the end of the turn.
 */
import { expect, test } from "@playwright/test";
import {
	agentTools,
	cleanupAp,
	command,
	git,
	installFakeGh,
	launchAp,
	mainTab,
	makeApProfile,
	recorded,
	refs,
	setAutopilot,
	slowPushes,
	startRun,
	status,
	waitForStatus,
	writeGate,
} from "./autopilot-harness";
import { exitApp } from "./harness";

const PUSH_ATTEMPTS = [
	{ tool: "bash", input: { command: "git push origin HEAD" } },
	{ tool: "bash", input: { command: "git push origin HEAD:main" } },
];

test("local only: the agent's push is blocked, the push switch is off and the remote never changes", async () => {
	test.setTimeout(150_000);
	const profile = await makeApProfile({ script: { cycleMs: 300, cycle: { tools: PUSH_ATTEMPTS } } });
	const before = refs(profile.remote, "refs/heads");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page));
		const run = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 3, "three cycles");
		expect(run.ship?.policy).toMatchObject({ autoPush: false, autoRelease: { on: false } });
		const blocked = (await agentTools(profile)).filter(
			entry => entry.tool === "bash" && typeof entry.blocked === "string",
		);
		expect(blocked.length).toBeGreaterThanOrEqual(6);
		expect(refs(profile.remote, "refs/heads")).toBe(before);
		expect(refs(profile.remote, "refs/tags")).toBe("");
		expect(run.ship?.queue).toEqual([]);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("auto push sends only the autopilot branch after a green cycle, never after a red one, never main", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		script: {
			cycleMs: 500,
			verify: ["green", "red", "green"],
			cycle: { tools: PUSH_ATTEMPTS },
			cycles: { "3": { ms: 4_000 } },
		},
	});
	const mainBefore = git(profile.remote, "rev-parse", "refs/heads/main");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page), { preset: "push" });
		const remoteBranch = async (branch: string) =>
			git(profile.remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
		const first = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 1, "cycle 1");
		const branch = first.branch as string;
		expect(first.settings?.ship.autoPush).toBe(true);
		await expect.poll(() => remoteBranch(branch), { timeout: 30_000 }).toBe(first.cycles?.[0]?.commit);
		// Cycle 2 is red: the push of cycle 2's commit does not happen.
		const second = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 2, "cycle 2");
		expect(second.cycles?.[1]?.verify).toBe("red");
		await page.waitForTimeout(800);
		expect(await remoteBranch(branch)).toBe(first.cycles?.[0]?.commit);
		// Cycle 3 is green: the tip moves to cycle 3's commit.
		const third = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 3, "cycle 3");
		await expect.poll(() => remoteBranch(branch), { timeout: 30_000 }).toBe(third.cycles?.[2]?.commit);
		// Only autopilot refs appeared; main is where it was, and the agent's own pushes were blocked.
		expect(git(profile.remote, "rev-parse", "refs/heads/main")).toBe(mainBefore);
		expect(git(profile.remote, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort()).toEqual(
			["refs/heads/main", `refs/heads/${branch}`].sort(),
		);
		expect((await status(page, tabId)).state).toBe("running");
		expect(
			(await agentTools(profile)).filter(entry => entry.tool === "bash" && typeof entry.blocked === "string").length,
		).toBeGreaterThanOrEqual(4);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("release is only offered when the repository defines a procedure", async () => {
	test.setTimeout(120_000);
	const without = await makeApProfile({ script: { cycleMs: 300 } });
	const { app, page } = await launchAp(without);
	try {
		const tab = await mainTab(page);
		const sheet = await status(page, tab);
		expect(sheet.active).toBe(false);
		expect(sheet.ship?.releaseProcedure).toBeUndefined();
		expect(sheet.ship?.releaseBlocked).toBeTruthy();
		const refused = await setAutopilot(page, tab, { action: "start", preset: "release" });
		expect(refused).toMatchObject({ success: false, code: "autopilot_no_release" });
		// Nothing was created: no second tab, no branch.
		expect((await page.evaluate(() => window.omp.tabs.list())).length).toBe(1);
		expect(git(without.project, "branch", "--list", "autopilot/*")).toBe("");
		// Switching it on in a running local run is refused the same way.
		const run = await startRun(page, tab);
		const configure = await setAutopilot(page, run, {
			action: "configure",
			ship: { autoRelease: { on: true, cadence: { kind: "every", n: 5 } } },
		});
		expect(configure).toMatchObject({ success: false, code: "autopilot_no_release" });
	} finally {
		await exitApp(app);
		await cleanupAp(without);
	}

	const withProcedure = await makeApProfile({ releaseProcedure: true, script: { cycleMs: 300 } });
	const second = await launchAp(withProcedure);
	try {
		const sheet = await status(second.page, await mainTab(second.page));
		expect(sheet.ship?.releaseProcedure).toMatchObject({
			file: "AGENTS.md",
			anchors: ["Change workflow", "Release"],
		});
		expect(sheet.ship?.releaseBlocked).toBeUndefined();
	} finally {
		await exitApp(second.app);
		await cleanupAp(withProcedure);
	}
});

const RELEASE_CYCLE = {
	tools: [
		{ tool: "bash", input: { command: "./scripts/gate.sh" } },
		{ tool: "bash", input: { command: "git push origin HEAD:main" } },
	],
	version: "v1.0.0",
	runUrl: "https://github.com/example/repo/actions/runs/7",
};
const EVERY_TWO = { autoPush: true, autoRelease: { on: true, cadence: { kind: "every", n: 2 } } };

test("a release after two green cycles runs the procedure, pushes HEAD to main and follows the run to success", async () => {
	test.setTimeout(240_000);
	const profile = await makeApProfile({
		releaseProcedure: true,
		script: { cycleMs: 400, cycles: { "3": { release: RELEASE_CYCLE } } },
	});
	await writeGate(profile, 0);
	await installFakeGh(profile, "success");
	const mainBefore = git(profile.remote, "rev-parse", "refs/heads/main");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page), { ship: EVERY_TWO });
		const run = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 3, "the release cycle", 120_000);
		const release = run.cycles?.[2];
		expect(release).toMatchObject({ area: "release", verify: "green", ship: { version: "v1.0.0" } });
		// The gate ran (exit 0), the guard let the main push through in the release scope, and it fast-forwarded.
		const tools = await agentTools(profile);
		expect(tools.find(entry => entry.input && JSON.stringify(entry.input).includes("gate.sh"))).toMatchObject({
			code: 0,
		});
		expect(git(profile.remote, "rev-parse", "refs/heads/main")).not.toBe(mainBefore);
		// The run url is polled (every 15 s) until the run completes.
		await waitForStatus(page, tabId, s => s.ship?.release?.state === "success", "the release run succeeds", 90_000);
		const after = await status(page, tabId);
		expect(after.ship?.release).toMatchObject({ version: "v1.0.0", state: "success" });
		expect(after.ship?.queue.find(item => item.kind === "release")).toMatchObject({ state: "done" });
		expect(after.state).toBe("running");
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("a failing gate pauses the run as release_failed and leaves main alone, though the last push is still going", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		releaseProcedure: true,
		script: {
			cycleMs: 400,
			cycles: {
				"3": {
					release: {
						tools: [{ tool: "bash", input: { command: "./scripts/gate.sh" } }],
						version: "v1.0.0",
						verify: "red",
					},
				},
			},
		},
	});
	await writeGate(profile, 1);
	// Each automatic push outlives the gap before the next cycle's `begin` (as a slow remote does), so the release
	// falls due while cycle 2's push is in flight; that push once held back every release.
	await slowPushes(profile, 1);
	const mainBefore = git(profile.remote, "rev-parse", "refs/heads/main");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page), { ship: EVERY_TWO });
		const paused = await waitForStatus(
			page,
			tabId,
			s => s.state === "paused",
			"paused after the failed gate",
			120_000,
		);
		expect(paused.reason).toBe("release_failed");
		const gate = (await agentTools(profile)).find(
			entry => entry.input && JSON.stringify(entry.input).includes("gate.sh"),
		);
		expect(gate).toMatchObject({ code: 1 });
		const releaseBegin = (await agentTools(profile)).find(entry => {
			const result = entry.result as { ship?: { due?: boolean } } | undefined;
			return entry.op === "begin" && result?.ship?.due === true;
		});
		expect(releaseBegin?.result).toMatchObject({ ship: { inFlight: { kind: "push" } } });
		expect(git(profile.remote, "rev-parse", "refs/heads/main")).toBe(mainBefore);
		// No automatic resume: it stays paused until the user acts.
		await page.waitForTimeout(2_000);
		expect((await status(page, tabId)).state).toBe("paused");
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("a failing release run (polled from the run url) pauses the run as release_failed", async () => {
	test.setTimeout(240_000);
	const profile = await makeApProfile({
		releaseProcedure: true,
		script: { cycleMs: 400, cycles: { "3": { release: RELEASE_CYCLE } } },
	});
	await writeGate(profile, 0);
	await installFakeGh(profile, "failure");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page), { ship: EVERY_TWO });
		const paused = await waitForStatus(
			page,
			tabId,
			s => s.state === "paused",
			"paused after the failed run",
			150_000,
		);
		expect(paused.reason).toBe("release_failed");
		expect(paused.ship?.release).toMatchObject({ version: "v1.0.0", state: "failure" });
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("'push now' in chat pushes the autopilot branch at the end of the turn; a forged quote is refused", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		script: { cycleMs: 3_000, cycles: { "2": { forgeQuote: "push now" } } },
	});
	const mainBefore = git(profile.remote, "rev-parse", "refs/heads/main");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page));
		// Cycle 1 is running: the user's own words reach it as a steer.
		await waitForStatus(page, tabId, s => s.now?.n === 1, "cycle 1 is running");
		const steer = await command(page, tabId, { type: "steer", message: "push now" });
		expect(steer.success).toBe(true);
		const first = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 1, "cycle 1 done", 60_000);
		const branch = first.branch as string;
		await expect
			.poll(() => git(profile.remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`), {
				timeout: 30_000,
			})
			.toBe(first.cycles?.[0]?.commit);
		expect(git(profile.remote, "rev-parse", "refs/heads/main")).toBe(mainBefore);
		const ships = (await agentTools(profile)).filter(entry => entry.op === "ship");
		expect(ships[0]).toMatchObject({ cycle: 1 });
		expect(ships[0]?.error).toBeUndefined();

		// Cycle 2: the agent claims the user said "push now" but nobody did: refused, nothing pushed for it.
		await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 2, "cycle 2 done", 60_000);
		const forged = (await agentTools(profile)).filter(entry => entry.op === "ship" && entry.cycle === 2);
		expect(String(forged[0]?.error)).toMatch(/Ship request refused/);
		await page.waitForTimeout(1_500);
		expect(git(profile.remote, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`)).toBe(
			first.cycles?.[0]?.commit,
		);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("the screen's Push, PR, merge and revert queue up during a turn and run in order at its end", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({ script: { cycleMs: 5_000 } });
	const mainBefore = git(profile.project, "rev-parse", "main");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page));
		await waitForStatus(
			page,
			tabId,
			s => (s.cycles?.length ?? 0) >= 1 && s.now?.n === 2,
			"cycle 2 is running",
			60_000,
		);
		const timeline: string[] = [];
		for (const action of [
			{ action: "ship", kind: "push" },
			{ action: "ship", kind: "pr" },
			{ action: "ship", kind: "merge", mode: "ff" },
			{ action: "ship", kind: "revert", cycle: 1 },
		]) {
			expect(await setAutopilot(page, tabId, action)).toMatchObject({ success: true });
			const now = await status(page, tabId);
			const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tabId);
			timeline.push(
				`${String(action.kind)} -> now=${now.now?.n} inflightRun=${tab?.lastRun === undefined} ${now.ship?.queue.map(item => `${item.kind}:${item.state}`).join(",")}`,
			);
		}
		const queued = await status(page, tabId);
		expect(
			queued.ship?.queue.map(item => [item.kind, item.state]),
			timeline.join(" | "),
		).toEqual([
			["push", "queued"],
			["pr", "queued"],
			["merge", "queued"],
			["revert", "queued"],
		]);
		// Nothing ran inside the turn.
		expect(git(profile.remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
		expect(git(profile.project, "rev-parse", "main")).toBe(mainBefore);

		const done = await waitForStatus(
			page,
			tabId,
			s =>
				(s.ship?.queue.length ?? 0) === 4 &&
				s.ship?.queue.every(item => item.state === "done" || item.state === "failed") === true,
			"the queue ran",
			60_000,
		);
		const states = Object.fromEntries((done.ship?.queue ?? []).map(item => [item.kind, item.state]));
		// A local bare remote is not a GitHub repository: the PR fails, and one failure does not block the rest.
		expect(states).toEqual({ push: "done", pr: "failed", merge: "done", revert: "done" });
		const branch = done.branch as string;
		expect(git(profile.remote, "for-each-ref", "--format=%(refname)", "refs/heads/autopilot")).toBe(
			`refs/heads/${branch}`,
		);
		// The merge fast-forwarded the user's checkout to the branch as it was; the revert is a new commit on the branch.
		expect(git(profile.project, "rev-parse", "main")).not.toBe(mainBefore);
		expect(git(profile.project, "merge-base", "--is-ancestor", "main", branch)).toBe("");
		const cycle1 = done.cycles?.find(cycle => cycle.n === 1);
		await expect
			.poll(async () => (await status(page, tabId)).cycles?.find(cycle => cycle.n === 1)?.reverted, {
				timeout: 15_000,
			})
			.toBe(true);
		expect(git(done.root as string, "log", "--format=%s", "-n", "1")).toMatch(/^Revert/);
		expect(cycle1?.commit).toBeTruthy();
		expect((await recorded(profile, "modes.autopilot_mark_reverted")).length).toBe(1);
		// The audit saw only what the ShipRunner did: the run was not paused.
		expect((await status(page, tabId)).state).toBe("running");
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});
