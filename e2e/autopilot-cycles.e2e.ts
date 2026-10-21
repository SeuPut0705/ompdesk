/**
 * Autopilot on the fake omp (`fixture/autopilot.ts`, rules imported from the bridge's own pure modules): the run's
 * cycles 1-2-3 in its new worktree tab with the chip and the work board (the strip in a narrow window, docked in a wide one; en light; every theme and
 * language with OMP_GUI_VARIANTS=1); Stop (the current cycle finishes, children's queues are emptied and their
 * tabs closed, ended:user, one notification); the approval cards and the questions an unattended run never gets;
 * the usage limit (a quota wait with an automatic booking that retries after the reset); the project guide. ■ and
 * its release confirmation are unit-tested (autopilot.test.ts, AutopilotBoard.test.tsx). Runs start from the Mode
 * popover's sheet (the user's own path) unless the spec needs options the sheet does not offer.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import {
	agentTools,
	cleanupAp,
	command,
	git,
	launchAp,
	mainTab,
	makeApProfile,
	recorded,
	setAutopilot,
	startFromSheet,
	startRun,
	status,
	tabIds,
	waitForRunTab,
	waitForStatus,
} from "./autopilot-harness";
import { capture, captureTo, exitApp, variants } from "./harness";

const TEXT = {
	en: { running: /Cycle \d/, close: "Close side panel", autopilot: "Autopilot", docOnly: "docs only" },
	ko: { running: /사이클 \d/, close: "사이드 패널 닫기", autopilot: "오토파일럿", docOnly: "문서만" },
} as const;

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`${language === "en" && theme === "light" ? "@smoke " : ""}cycles 1, 2, 3 follow in a new worktree tab, shown on the chip and the work board, never a panel (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const profile = await makeApProfile({
				language,
				theme,
				script: {
					cycleMs: 700,
					// What the bridge measures of a cycle (`change`) and why it did not take a green claim (`verifyNote`).
					cycles: {
						"1": { change: { files: 3, added: 42, removed: 5, commits: 1 } },
						"2": { change: { files: 1, added: 8, removed: 2, commits: 1, docOnly: true } },
						"3": {
							verify: "skipped",
							verifyNote: { kind: "no_check" },
							change: { files: 2, added: 19, removed: 0, commits: 1 },
						},
					},
				},
			});
			const { app, page } = await launchAp(profile);
			try {
				// A new worktree tab on autopilot/<date>; the folder the user opened is untouched.
				const { tabId, cwd, branch } = await startFromSheet(page, language);
				expect(branch).toMatch(/^autopilot\/\d{4}-\d{2}-\d{2}/);
				expect(git(cwd, "branch", "--show-current")).toBe(branch);
				expect(cwd.startsWith(path.join(profile.root, "wt"))).toBe(true);
				expect(git(profile.project, "branch", "--show-current")).toBe("main");

				const run = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 3, "three cycles");
				expect(run.cycles?.map(cycle => cycle.n).slice(0, 3)).toEqual([1, 2, 3]);
				// Rotation: three different areas, the longest-waiting first.
				expect(new Set(run.cycles?.slice(0, 3).map(cycle => cycle.area)).size).toBe(3);
				expect(run.totals?.tokens).toBeGreaterThan(3_000);
				// Real commits, one per cycle, on the autopilot branch only.
				expect(git(cwd, "log", "--format=%s", "main..HEAD").split("\n").length).toBeGreaterThanOrEqual(3);

				// No panel opens by itself when a run starts: the run's home is the work board. In a window too narrow
				// for the board to dock, the composer's "show the run" expands the strip into it.
				await expect(page.getByRole("button", { name: TEXT[language].close })).toHaveCount(0);
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1000, 820));
				await expect(page.locator("[data-work-chip]").first()).toContainText(TEXT[language].running);
				await page.locator("[data-autopilot-chip-open]").click();
				const strip = page.locator("[data-work-strip-panel]");
				await expect(strip.locator("[data-autopilot-stop]")).toBeVisible();
				await expect(strip.locator("[data-autopilot-cycle-live], [data-autopilot-between]").first()).toBeVisible();
				await capture(page, `${language}-${theme}-strip`);

				// Docked beside the transcript (a wider window) the board is the run's: its head names the run and its
				// state, then the cycles with their verify result and totals.
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1700, 900));
				const board = page.locator("[data-work-board-panel]");
				await expect(board.locator("[data-autopilot-state]")).toHaveAttribute("data-autopilot-state", "running");
				await expect(board.locator("[data-board-autopilot-text]")).toContainText(TEXT[language].running);
				await expect(board.locator("[data-autopilot-totals]")).toBeVisible();
				// The board lists the newest five cycles and folds the older ones behind "+N more" (unfolded, it lists
				// them all from then on); the fake run keeps cycling every 700 ms, so on a slow machine cycle 1 is already
				// folded here, or folds a moment later. Unfold until it shows.
				const cycles = board.locator('[data-board-section="cycles"]');
				await expect
					.poll(async () => {
						const more = cycles.locator("[data-board-more]");
						if ((await more.count()) > 0) await more.click();
						return cycles.locator('[data-autopilot-cycle="1"]').count();
					})
					.toBe(1);
				for (const n of [1, 2]) {
					await expect(board.locator(`[data-autopilot-cycle="${n}"]`)).toHaveAttribute("data-verify", "green");
				}
				// Each cycle's verdict is a painted dot, not an empty inline span.
				const dot = await board
					.locator('[data-autopilot-cycle="1"] [data-autopilot-verify-dot] > span')
					.boundingBox();
				expect(dot?.width ?? 0).toBeGreaterThan(0);
				expect(dot?.height ?? 0).toBeGreaterThan(0);
				// A reported green the bridge did not take shows why, and every cycle says how much it changed: each
				// cycle's details open in place.
				await expect(board.locator('[data-autopilot-cycle="3"]')).toHaveAttribute("data-verify", "skipped");
				for (const n of [3, 2, 1])
					await board.locator(`[data-autopilot-cycle="${n}"] button[data-board-expands]`).click();
				await expect(
					board.locator('[data-autopilot-cycle="3"] [data-autopilot-verify-note="no_check"]'),
				).toBeVisible();
				await expect(board.locator('[data-autopilot-cycle="1"] [data-autopilot-change]')).toBeVisible();
				await expect(board.locator('[data-autopilot-cycle="2"]')).toContainText(TEXT[language].docOnly);
				await capture(page, `${language}-${theme}-board-run`);
				const captures = process.env.OMP_GUI_AUTOPILOT_CAPTURES;
				await captureTo(captures, page, `autopilot-board-${language}-${theme}`);

				// The Mode popover shows the run instead of the sheet.
				await page.locator("[data-run-settings-trigger]").click();
				await expect(page.locator("[data-autopilot-run]")).toBeVisible();
				await capture(page, `${language}-${theme}-mode`);
				await page.keyboard.press("Escape");
				// And the composer chip names the cycle and the area.
				await expect(page.locator("[data-run-settings-trigger]")).toContainText(TEXT[language].running);

				// The worktree's folder (`gui-<date>-<hash>`) never shows: the project and the kind do, the path is the tooltip.
				const project = path.basename(profile.project);
				const worktreeName = `${project} · ${TEXT[language].autopilot}`;
				await expect(page.locator("[data-titlebar-worktree]")).toHaveText(TEXT[language].autopilot);
				await expect(page.locator(".omp-titlebar-project").first()).toHaveText(project);
				await expect(page.locator("[data-board-project]")).toHaveText(worktreeName);
				// The run is a row of its project's own group, marked as a run; no group of its own.
				const runRow = page.locator(".omp-sidebar-session-row").filter({
					has: page.locator('[data-sidebar-worktree="autopilot"]'),
				});
				await expect(runRow).toHaveCount(1);
				expect(
					await runRow.evaluate(row => {
						const key = row.closest("[data-session-group]")?.getAttribute("data-session-group");
						return [...document.querySelectorAll("[data-workspace-group]")]
							.find(header => header.getAttribute("data-workspace-group") === key)
							?.textContent?.trim();
					}),
				).toBe(project);
				await expect(page.locator("[data-workspace-group]", { hasText: TEXT[language].autopilot })).toHaveCount(0);
				await expect.poll(() => page.title()).toContain(worktreeName);
				const visible = await page.locator("body").innerText();
				expect(visible).not.toMatch(/gui-2026|gui-agent/);
				expect(await page.title()).not.toMatch(/gui-2026|gui-agent/);
				expect(await runRow.locator("button[title]").first().getAttribute("title")).toContain(
					TEXT[language].autopilot,
				);
				await capture(page, `${language}-${theme}-board`);

				// The overrides were applied to this session only: ask is gone, approvals are yolo, config.yml is untouched.
				const arm = (await recorded(profile, "fixture_autopilot_session")).find(entry => entry.action === "arm");
				expect(arm).toMatchObject({ role: "parent", overrides: { "tools.approvalMode": "yolo" } });
				expect(arm?.removedTools).toContain("ask");
				expect(await fs.readdir(profile.agent)).not.toContain("config.yml");
			} finally {
				await exitApp(app);
				await cleanupAp(profile);
			}
		});

test("Stop lets the cycle in flight finish, empties and closes the children, ends the run and notifies once", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		script: { cycleMs: 600, childMs: 6_000, cycle: { children: 2, endTwice: true } },
	});
	const { app, page } = await launchAp(profile);
	try {
		await app.evaluate(({ Notification }) => {
			const sent: string[] = [];
			(globalThis as { notices?: string[] }).notices = sent;
			const original = Notification.prototype.show;
			Notification.prototype.show = function (this: Electron.Notification) {
				sent.push(`${this.title}|${this.body}`);
				return original.call(this);
			};
		});
		const tabId = await startRun(page, await mainTab(page), { maxParallel: 2 });
		// Mid-cycle: two children run.
		const running = await waitForStatus(
			page,
			tabId,
			s => (s.children?.filter(child => child.status === "running").length ?? 0) === 2,
			"two children run",
		);
		const children = (running.children ?? []).map(child => child.tabId);
		// The live cycle names the item the agent picked, not the rotation's guess.
		expect(running.now?.title).toMatch(/^Cycle 1: /);
		expect((await tabIds(page)).length).toBeGreaterThanOrEqual(4);
		// A follow-up waits in each child's queue.
		for (const child of children) {
			expect(await command(page, child, { type: "follow_up", message: "later" })).toMatchObject({ success: true });
		}
		const removedBefore = (await recorded(profile, "remove_queued_message")).length;
		expect(await setAutopilot(page, tabId, { action: "stop" })).toMatchObject({ success: true });
		expect((await status(page, tabId)).state).toBe("stopping");
		// Their queues are emptied (the running turn is left alone): nothing is aborted.
		await expect
			.poll(async () => (await recorded(profile, "remove_queued_message")).length - removedBefore, {
				timeout: 30_000,
			})
			.toBe(2);
		expect((await recorded(profile, "abort")).length).toBe(0);

		const ended = await waitForStatus(page, tabId, s => s.state === "ended", "the run ends", 90_000);
		expect(ended.reason).toBe("user");
		// The cycle in flight finished and was recorded; no next cycle started.
		expect(ended.cycles?.length).toBe(1);
		expect(ended.cycles?.[0]?.verify).toBe("green");
		// A second `end` in the same turn (a stop steer, a second thought) never replaced the first report.
		expect(ended.cycles?.[0]?.title).toMatch(/^Cycle 1: /);
		expect(ended.cycles?.[0]?.commit).toBeTruthy();
		await page.waitForTimeout(2_500);
		expect((await status(page, tabId)).cycles?.length).toBe(1);
		// The children's tabs are closed; the run's own tab and the user's stay.
		await expect.poll(async () => (await tabIds(page)).length, { timeout: 30_000 }).toBe(2);
		// Overrides restored, the goal dropped.
		expect((await recorded(profile, "fixture_autopilot_session")).some(entry => entry.action === "disarm")).toBe(
			true,
		);
		expect((await recorded(profile, "goal")).map(entry => entry.op)).toEqual(
			expect.arrayContaining(["create", "pause", "drop"]),
		);
		// Exactly one notification for the end (stops and ends only; cycles are not announced by default).
		const notices = await app.evaluate(() => (globalThis as { notices?: string[] }).notices ?? []);
		expect(notices.length).toBe(1);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("approvals and questions: yolo override, the approver answers leftover cards, a violating card is denied, no ask tool", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		script: {
			cycleMs: 500,
			cycles: {
				"1": { card: { title: "Allow tool: bash\nbun test" } },
				"2": { card: { title: "Allow tool: bash\ngit push --force origin main" } },
			},
		},
	});
	const { app, page } = await launchAp(profile);
	try {
		await startFromSheet(page, "en");
		await expect
			.poll(async () => (await recorded(profile, "fixture_autopilot_card")).length, { timeout: 60_000 })
			.toBeGreaterThanOrEqual(2);
		const cards = await recorded(profile, "fixture_autopilot_card");
		expect(cards[0]).toMatchObject({ title: "Allow tool: bash\nbun test", answer: "Approve" });
		expect(cards[1]).toMatchObject({ title: "Allow tool: bash\ngit push --force origin main", answer: "Deny" });
		// The renderer draws no approval card for an unattended run (it holds one back while main answers).
		await expect(page.getByRole("button", { name: /^Approve$/ })).toHaveCount(0);
		// The override is the session's own: ask is off the tool set, the global approval mode is untouched.
		const arm = (await recorded(profile, "fixture_autopilot_session")).find(entry => entry.action === "arm");
		expect(arm?.overrides).toEqual({ "tools.approvalMode": "yolo" });
		expect(arm?.removedTools).toContain("ask");
		expect(
			(await recorded(profile, "set_setting")).filter(entry => String(entry.path ?? "").includes("approval")),
		).toEqual([]);
		// The denied card did not stop the run, and the agent's own commands stayed behind the guard.
		expect((await agentTools(profile)).filter(entry => typeof entry.blocked === "string")).toEqual([]);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("a usage limit waits for the quota in main, wakes at the reset and retries the turn", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		script: { cycleMs: 500, cycles: { "2": { quota: true, quotaResetMs: 9_000 } } },
		env: { OMP_GUI_TEST_USAGE_RESET_MS: "9000" },
	});
	const { app, page } = await launchAp(profile);
	try {
		const { tabId } = await startFromSheet(page, "en");
		// The turn of cycle 2 ends on the limit: no record for it; main journals the wait with the reset it wakes at,
		// and no renderer booking exists (main owns the wake).
		const waiting = await waitForStatus(page, tabId, s => s.state === "waiting_quota", "the quota wait", 30_000);
		expect(waiting.quotaResetAt).toBeGreaterThan(Date.now() - 60_000);
		expect(waiting.cycles?.length).toBe(1);
		expect(await page.evaluate(() => window.omp.prefs.get("quotaResume"))).toBeFalsy();
		await page.locator("[data-autopilot-chip-open]").click();
		await expect(page.locator('[data-board-section="autopilot"]').first()).toBeVisible();
		await expect(page.locator("[data-run-settings-trigger]")).toContainText(/quota|until|\d{2}:\d{2}/i);
		await capture(page, "quota-wait");
		// After the reset stock `retry` runs, cycle 2 completes and the run goes on.
		await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 3, "the run resumes after the reset", 90_000);
		expect(
			(await recorded(profile, "prompt")).filter(entry => entry.message === "/retry").length,
		).toBeGreaterThanOrEqual(1);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("the project guide: Start builds one from the repo's facts (its Release section says the project does not release), it is the branch's first commit (never main's), and every begin reads the file afresh", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({ script: { cycleMs: 900 } });
	const { app, page } = await launchAp(profile);
	try {
		await page.locator("[data-run-settings-trigger]").click();
		await page.getByRole("tab", { name: /^(Autopilot|오토파일럿)/ }).click();
		// Nobody edits the guide in the sheet: the app owns it.
		await expect(page.locator("[data-autopilot-sheet]")).toBeVisible();
		await expect(page.locator("[data-autopilot-guide]")).toHaveCount(0);
		await page.locator("[data-autopilot-start]").click();
		const { cwd } = await waitForRunTab(page);

		// The guide is the autopilot branch's first commit; the user's checkout and branch never get it. The fake omp has
		// no smol model, so it is the template over what the repo says: no tags, no publish path, so no release.
		const [first] = git(cwd, "log", "--reverse", "--format=%H %s", "main..HEAD").split("\n");
		expect(first).toMatch(/ docs: add AUTOPILOT\.md guide$/);
		expect(git(cwd, "show", "--name-only", "--format=", first?.split(" ")[0] ?? "")).toBe("AUTOPILOT.md");
		const guide = await fs.readFile(path.join(cwd, "AUTOPILOT.md"), "utf8");
		expect(guide).toMatch(/^# Autopilot guide: project/);
		expect(guide).toContain("AGENTS.md");
		expect(guide).toMatch(/\n## Release\n\nReleases: no\n/);
		expect(git(profile.project, "log", "--format=%s")).toBe("seed");
		await expect(fs.access(path.join(profile.project, "AUTOPILOT.md"))).rejects.toThrow();

		const guideOf = async (marker: string) =>
			(await agentTools(profile)).some(
				entry =>
					entry.op === "begin" &&
					(entry.result as { guide?: { text?: string } } | undefined)?.guide?.text?.includes(marker),
			);
		await expect.poll(() => guideOf("Releases: no"), { timeout: 60_000 }).toBe(true);
		// An edit applies from the next cycle's begin.
		await fs.writeFile(path.join(cwd, "AUTOPILOT.md"), "# Our guide\n\nPrefer small diffs. MARKER-TWO\n");
		await expect.poll(() => guideOf("MARKER-TWO"), { timeout: 60_000 }).toBe(true);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});
