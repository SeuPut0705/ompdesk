/**
 * Autopilot's shipping on the fake omp with a local bare remote: the release path (a fake gate script and a fake
 * `gh`, the run url polled), "push now" in chat (a forged quote is refused), and the screen's Push / PR / merge /
 * revert queue run at the end of the turn, and the branch a run is on (an existing branch pushed to the local bare
 * remote with main untouched; the sheet offering main only once the folder is off it, with its warning; captures of
 * the sheet with OMP_GUI_AUTOPILOT_CAPTURES). The push and release rules themselves (local only, push after green,
 * no release without a procedure, a failing gate or run) are unit-tested in src/main/autopilot*.test.ts and
 * src/main/bridge-autopilot-*.test.ts.
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
	setAutopilot,
	startRun,
	status,
	waitForStatus,
	writeGate,
} from "./autopilot-harness";
import { captureTo, exitApp } from "./harness";

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

test("'push now' in chat pushes the autopilot branch at the end of the turn; a forged quote is refused", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		script: { cycleMs: 3_000, cycles: { "2": { forgeQuote: "push now" } } },
	});
	const mainBefore = git(profile.remote, "rev-parse", "refs/heads/main");
	const { app, page } = await launchAp(profile);
	try {
		// Local level on purpose: only the user's "push now" may push here (the default would push every green cycle).
		const tabId = await startRun(page, await mainTab(page), { preset: "local" });
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

test("a run on an existing branch commits there and Push moves that branch of the local bare remote, never main", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({ script: { cycleMs: 2_000 } });
	git(profile.project, "branch", "feature/x");
	git(profile.project, "push", "-q", "origin", "feature/x");
	const mainBefore = git(profile.remote, "rev-parse", "refs/heads/main");
	const featureBefore = git(profile.remote, "rev-parse", "refs/heads/feature/x");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page), {
			preset: "push",
			branch: { kind: "existing", name: "feature/x" },
		});
		const first = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 1, "cycle 1 done", 90_000);
		expect(first.branch).toBe("feature/x");
		const commit = first.cycles?.[0]?.commit;
		expect(commit).toBeTruthy();
		await expect
			.poll(() => git(profile.remote, "rev-parse", "refs/heads/feature/x"), { timeout: 30_000 })
			.toBe(commit);
		expect(commit).not.toBe(featureBefore);
		// Same name upstream, the cycle's commit on top of where the branch was; main did not move.
		expect(git(profile.remote, "log", "--format=%s", `${featureBefore}..feature/x`)).toContain("autopilot: cycle 1");
		expect(git(profile.remote, "rev-parse", "refs/heads/main")).toBe(mainBefore);
		expect(git(profile.remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
		// The user's own folder stayed on main and no autopilot/ branch exists anywhere.
		expect(git(profile.project, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(git(profile.project, "branch", "--list", "autopilot/*")).toBe("");
		expect(git(profile.project, "rev-parse", "main")).toBe(mainBefore);
		const pushes = (await agentTools(profile)).filter(entry => entry.error !== undefined);
		expect(pushes).toEqual([]);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

const SHEET = {
	en: {
		tab: /^Autopilot/,
		push: "Push",
		via: /^autopilot\/\d{4}-\d{2}-\d{2} → push to main$/,
		warning: "Commits go straight to main; Push goes to main.",
	},
	ko: {
		tab: /^오토파일럿/,
		push: "푸시",
		via: /^작업 브랜치 autopilot\/\d{4}-\d{2}-\d{2} → 푸시 대상 main$/,
		warning: "커밋이 main에 바로 쌓이고, 푸시는 main에 해요",
	},
} as const;

for (const language of ["en", "ko"] as const)
	test(`target = main while the user's folder is on main: the run works on its own branch, the remote main moves, the folder is untouched (${language})`, async () => {
		test.setTimeout(240_000);
		const profile = await makeApProfile({ language, script: { cycleMs: 2_000 } });
		git(profile.project, "branch", "feature/x");
		git(profile.project, "push", "-q", "origin", "feature/x");
		const mainBefore = git(profile.remote, "rev-parse", "refs/heads/main");
		const captures = process.env.OMP_GUI_AUTOPILOT_CAPTURES;
		const { app, page } = await launchAp(profile);
		const text = SHEET[language];
		const openSheet = async () => {
			await page.locator("[data-run-settings-trigger]").click();
			await page.getByRole("tab", { name: text.tab }).click();
			await expect(page.locator("[data-autopilot-sheet]")).toBeVisible();
			// The Branch row sits in the sheet's one Advanced disclosure.
			await page.locator("[data-autopilot-sheet] [data-settings-advanced] summary").click();
		};
		try {
			await openSheet();
			const branch = page.locator("[data-autopilot-branch] select");
			const mainOption = branch.locator('option[value="branch:main"]');
			await expect(branch).toHaveValue("new");
			await expect(page.locator("input[data-autopilot-branch-name]")).toHaveValue(/^autopilot\/\d{4}-\d{2}-\d{2}$/);
			// The user's own folder is on main, and main is still selectable: the run works on its own branch off it.
			await expect(mainOption).not.toHaveAttribute("disabled", "");
			await expect(page.locator("[data-autopilot-branch-warning]")).toHaveCount(0);
			await captureTo(captures, page, `autopilot-branch-sheet-${language}-light`);
			await branch.selectOption("branch:main");
			await expect(page.locator("[data-autopilot-branch-warning]")).toHaveText(text.warning);
			await expect(page.locator("[data-autopilot-branch-via]")).toHaveText(text.via);
			await expect(page.locator("input[data-autopilot-branch-name]")).toHaveCount(0);
			await captureTo(captures, page, `autopilot-branch-main-warning-${language}-light`);
			// Pushing to the default branch is only ever an explicit level: Automatic never pushes main.
			await page
				.locator("[data-autopilot-sheet] [role='tab']")
				.filter({ hasText: new RegExp(`^${text.push}$`) })
				.click();

			await page.locator("[data-autopilot-start]").click();
			let tabId = "";
			await expect
				.poll(
					async () => {
						const tabs = await page.evaluate(() => window.omp.tabs.list());
						tabId = tabs.find(tab => tab.worktree?.branch.startsWith("autopilot/"))?.tabId ?? "";
						return tabId;
					},
					{ timeout: 60_000, message: "the run's tab opens on its own branch" },
				)
				.not.toBe("");
			const first = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 1, "cycle 1 done", 90_000);
			expect(first.target).toBe("main");
			const commit = first.cycles?.[0]?.commit;
			expect(commit).toBeTruthy();
			// Push pushed HEAD:main, fast-forward: the remote main moved to the cycle's commit.
			await expect.poll(() => git(profile.remote, "rev-parse", "refs/heads/main"), { timeout: 30_000 }).toBe(commit);
			expect(git(profile.remote, "log", "--format=%s", `${mainBefore}..main`)).toContain("autopilot: cycle 1");
			expect(git(profile.remote, "rev-parse", "refs/heads/feature/x")).toBe(
				git(profile.project, "rev-parse", "feature/x"),
			);
			// The user's folder is untouched: still on main, local main not moved, a clean working tree.
			expect(git(profile.project, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
			expect(git(profile.project, "rev-parse", "main")).toBe(mainBefore);
			expect(git(profile.project, "status", "--porcelain")).toBe("");
		} finally {
			await exitApp(app);
			await cleanupAp(profile);
		}
	});
