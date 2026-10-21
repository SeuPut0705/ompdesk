/**
 * Capture of the Background tasks sheet (opened from the work board's job row) with stock's jobs tree (the fake omp's `OMP_GUI_TEST_JOB_TREE=1` rows plus the
 * `fixture:subagents` roster) in Korean on a desktop window: a subagent's shells and its nested subagent's shell
 * under it, the roster's titles on the task rows, a header for a subagent whose task job is gone, and Cancel only on
 * the session's own jobs. Registered only with `OMP_GUI_JOBS_TREE_SHOTS=<dir>`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { captureTo, exitApp, launchApp } from "./harness";

const shots = process.env.OMP_GUI_JOBS_TREE_SHOTS;

if (shots) {
	test("background tasks tree capture (ko, desktop)", async () => {
		test.setTimeout(180_000);
		const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-jobs-tree-")));
		const project = path.join(profile, "project");
		const desktop = path.join(profile, "desktop");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "ko", themeName: "light", firstRunComplete: true }),
		);
		const app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_JOB_TREE: "1" } });
		try {
			const page = await app.firstWindow();
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			const roster = await page.evaluate(() =>
				window.omp.rpc.command({ type: "bash", command: "fixture:subagents" }),
			);
			expect(roster.success).toBe(true);

			await page.locator('[data-board-job="dev"]').click();
			const sheet = page.locator('[data-view-sheet="jobs"]');
			await expect(sheet.locator('[data-job-id="sh-locales"]')).toBeVisible({ timeout: 15_000 });

			const depth = (id: string) => sheet.locator(`[data-job-id="${id}"]`).getAttribute("data-job-depth");
			expect([
				await depth("sa-explore"),
				await depth("sh-rg"),
				await depth("sa-nested"),
				await depth("sh-locales"),
			]).toEqual(["0", "1", "1", "2"]);
			await expect(sheet.locator('[data-job-id="sa-explore"]')).toContainText("Map the settings code");
			await expect(sheet.locator('[data-job-id="sa-nested"]')).toContainText("Read locale files");
			await expect(sheet.locator('[data-job-agent-id="sa-evicted"]')).toHaveText("sa-evicted");
			const cancels = (id: string) => sheet.locator(`[data-job-id="${id}"] button`, { hasText: "취소" }).count();
			expect([
				await cancels("dev"),
				await cancels("sa-explore"),
				await cancels("sh-rg"),
				await cancels("sh-locales"),
			]).toEqual([1, 1, 0, 0]);

			await page.mouse.move(0, 0);
			await captureTo(shots, page, "jobs-tree-ko-desktop");
			await page
				.getByRole("dialog", { name: "백그라운드 작업" })
				.screenshot({ animations: "disabled", path: path.join(shots, "jobs-tree-ko-panel.png") });
		} finally {
			await exitApp(app);
		}
	});
}
