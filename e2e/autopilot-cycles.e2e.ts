/**
 * Autopilot on the fake omp (`fixture/autopilot.ts`, rules imported from the bridge's own pure modules): the run's
 * cycles 1-2-3 in its new worktree tab with the chip, the work board and the panel (en light; every theme and
 * language with OMP_GUI_VARIANTS=1); Stop (the current cycle finishes, children's queues are emptied and their
 * tabs closed, ended:user, one notification); the approval cards and the questions an unattended run never gets;
 * the usage limit (a quota wait with an automatic booking that retries after the reset); the project guide. ■ and
 * its release confirmation are unit-tested (autopilot.test.ts, AutopilotPanel.test.tsx). Runs start from the Mode
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
import { capture, exitApp, variants } from "./harness";

const TEXT = {
	en: { running: /Cycle \d/, close: "Close side panel", autopilot: "Autopilot" },
	ko: { running: /사이클 \d/, close: "사이드 패널 닫기", autopilot: "오토파일럿" },
} as const;

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`${language === "en" && theme === "light" ? "@smoke " : ""}cycles 1, 2, 3 follow in a new worktree tab with the chip, the board and the panel (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const profile = await makeApProfile({ language, theme, script: { cycleMs: 700 } });
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

				// The screen opens by itself when a run starts: timeline rows with the verify result, totals, state badge.
				await expect(page.locator("[data-autopilot-panel]")).toBeVisible();
				for (const n of [1, 2, 3]) {
					await expect(page.locator(`[data-autopilot-cycle="${n}"]`)).toHaveAttribute("data-verify", "green");
				}
				await expect(page.locator("[data-autopilot-totals]")).toBeVisible();
				await expect(page.locator("[data-autopilot-state]")).toHaveAttribute("data-autopilot-state", "running");
				await capture(page, `${language}-${theme}-panel`);

				// The Mode popover shows the run instead of the sheet.
				await page.locator("[data-composer-modes-trigger]").click();
				await expect(page.locator("[data-autopilot-run]")).toBeVisible();
				await capture(page, `${language}-${theme}-mode`);
				await page.keyboard.press("Escape");

				// With the panel closed the work board carries the run: state with the cycle, the recent items, the totals.
				// The board needs room beside the transcript column: a wider window than the default.
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1700, 900));
				await page.getByRole("button", { name: TEXT[language].close }).click();
				await expect(page.locator("[data-autopilot-panel]")).toHaveCount(0);
				await expect(page.locator("[data-board-autopilot-text]")).toContainText(TEXT[language].running);
				await expect(page.locator("[data-board-cycle]").first()).toBeVisible();
				await expect(page.locator("[data-board-autopilot-totals]")).toBeVisible();
				// And the composer chip names the cycle and the area.
				await expect(page.locator("[data-composer-modes-trigger]")).toContainText(TEXT[language].running);

				// The worktree's folder (`gui-<date>-<hash>`) never shows: the project and the kind do, the path is the tooltip.
				const project = path.basename(profile.project);
				const worktreeName = `${project} · ${TEXT[language].autopilot}`;
				await expect(page.locator("[data-titlebar-worktree]")).toHaveText(TEXT[language].autopilot);
				await expect(page.locator(".omp-titlebar-project").first()).toHaveText(project);
				await expect(page.locator("[data-board-project]")).toHaveText(worktreeName);
				await expect(page.locator(`[data-worktree-group="${project}"]`).first()).toHaveText(
					TEXT[language].autopilot,
				);
				await expect.poll(() => page.title()).toContain(worktreeName);
				const visible = await page.locator("body").innerText();
				expect(visible).not.toMatch(/gui-2026|gui-agent/);
				expect(await page.title()).not.toMatch(/gui-2026|gui-agent/);
				expect(
					await page
						.locator(`[data-worktree-group="${project}"]`)
						.first()
						.locator("button[title]")
						.getAttribute("title"),
				).toContain(cwd);
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

test("a usage limit waits for the quota, books a resume by itself and retries after the reset", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		script: { cycleMs: 500, cycles: { "2": { quota: true, quotaResetMs: 9_000 } } },
		env: { OMP_GUI_TEST_USAGE_RESET_MS: "9000" },
	});
	const { app, page } = await launchAp(profile);
	try {
		const { tabId } = await startFromSheet(page, "en");
		// The turn of cycle 2 ends on the limit: no record for it, and a booking exists without a click.
		await expect
			.poll(
				async () =>
					page.evaluate(async () => {
						const booked = (await window.omp.prefs.get("quotaResume")) as Record<string, number> | undefined;
						return booked ? Object.keys(booked).length : 0;
					}),
				{ timeout: 30_000 },
			)
			.toBeGreaterThan(0);
		const waiting = await status(page, tabId);
		expect(waiting.cycles?.length).toBe(1);
		await expect(page.locator("[data-autopilot-now]")).toBeVisible();
		await expect(page.locator("[data-composer-modes-trigger]")).toContainText(/quota|until|\d{2}:\d{2}/i);
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

test("the project guide: a repo without one gets a draft in the sheet, the edited text is the branch's first commit (never main's), and every begin reads the file afresh", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({ script: { cycleMs: 900 } });
	const { app, page } = await launchAp(profile);
	try {
		await page.locator("[data-composer-modes-trigger]").click();
		await page.getByRole("tab", { name: /^(Autopilot|오토파일럿)/ }).click();
		const box = page.locator("[data-autopilot-guide]");
		// The fake omp has no smol model: the draft is the deterministic template over what the repo says.
		await expect(box).toHaveValue(/# Autopilot guide: project/);
		await expect(box).toHaveValue(/AGENTS\.md/);
		await box.fill("# Our guide\n\nPrefer small diffs. MARKER-ONE\n");
		await page.locator("[data-autopilot-start]").click();
		const { cwd } = await waitForRunTab(page);

		// The guide is the autopilot branch's first commit; the user's checkout and branch never get it.
		const [first] = git(cwd, "log", "--reverse", "--format=%H %s", "main..HEAD").split("\n");
		expect(first).toMatch(/ docs: add AUTOPILOT\.md guide$/);
		expect(git(cwd, "show", "--name-only", "--format=", first?.split(" ")[0] ?? "")).toBe("AUTOPILOT.md");
		expect(git(profile.project, "log", "--format=%s")).toBe("seed");
		await expect(fs.access(path.join(profile.project, "AUTOPILOT.md"))).rejects.toThrow();

		const guideOf = async (marker: string) =>
			(await agentTools(profile)).some(
				entry =>
					entry.op === "begin" &&
					(entry.result as { guide?: { text?: string } } | undefined)?.guide?.text?.includes(marker),
			);
		await expect.poll(() => guideOf("MARKER-ONE"), { timeout: 60_000 }).toBe(true);
		// An edit applies from the next cycle's begin.
		await fs.writeFile(path.join(cwd, "AUTOPILOT.md"), "# Our guide\n\nPrefer small diffs. MARKER-TWO\n");
		await expect.poll(() => guideOf("MARKER-TWO"), { timeout: 60_000 }).toBe(true);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});
