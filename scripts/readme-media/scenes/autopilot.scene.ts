/**
 * Autopilot: start a run from the Mode popover, watch cycles 1-2-3 (audit, implement, verify, commit) land in the
 * run's own worktree tab, then close the side panel to see the same run on the work board and the composer chip.
 * Uses the Autopilot fake (`e2e/fixture/autopilot.ts`), whose commits are real git in the temp repository.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { cleanupAp, makeApProfile, waitForRunTab, waitForStatus } from "../../../e2e/autopilot-harness";
import { exitApp } from "../../../e2e/harness";
import { fixture, launch, Recorder, WORK_DIR } from "../lib";

test("autopilot cycles", async () => {
	// The profile's temp folders live under a fixed, neutral path.
	await fs.mkdir(WORK_DIR, { recursive: true });
	process.env.TMPDIR = WORK_DIR;
	const profile = await makeApProfile({
		language: "en",
		theme: "light",
		script: { cycleMs: 2_400 },
		env: { OMP_GUI_README_SCENE: "model" },
	});
	// The example repository is named acme-web, like the other scenes'.
	const renamed = path.join(profile.root, "acme-web");
	await fs.rename(profile.project, renamed);
	profile.project = renamed;
	const prefsFile = path.join(profile.desktop, "prefs.json");
	await fs.writeFile(
		prefsFile,
		JSON.stringify({ ...JSON.parse(await fs.readFile(prefsFile, "utf8")), lastProject: renamed }),
	);
	const { app, page } = await launch(profile, 1440, 900);
	const recorder = new Recorder("autopilot", { width: 1440, height: 900, maxHold: 1_400, endHold: 2_500 });
	try {
		await recorder.reset();
		await recorder.attach(page);
		await page.waitForTimeout(1_000);
		await page.locator("[data-composer-modes-trigger]").click();
		await page.getByRole("tab", { name: /^Autopilot/ }).click();
		await page.waitForTimeout(2_200);
		await page.locator("[data-autopilot-start]").click();
		const { tabId } = await waitForRunTab(page);
		await fixture(page, "fixture:title:Autopilot run", tabId);
		await expect(page.locator("[data-autopilot-panel]")).toBeVisible();
		await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 3, "three cycles", 90_000);
		for (const n of [1, 2, 3])
			await expect(page.locator(`[data-autopilot-cycle="${n}"]`)).toHaveAttribute("data-verify", "green");
		await page.waitForTimeout(1_800);
		await page.getByRole("button", { name: "Close side panel" }).click();
		await page.mouse.move(700, 450);
		await expect(page.locator("[data-board-autopilot-text]")).toContainText(/Cycle \d/);
		await page.waitForTimeout(2_800);
		await recorder.finish({ width: 1600 });
	} finally {
		await recorder.detach();
		await exitApp(app);
		await cleanupAp(profile);
	}
});
