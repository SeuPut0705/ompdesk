/**
 * What the agent writes to the person in a reply that also calls tools stays in the chat: the owner saw such text
 * stream in and vanish once the tools started (6 Nov 2026), folded into the collapsed work card. Live (the call still
 * running), finished, and after a reload. `OMP_GUI_ANSWER_VISIBLE_SHOTS=<dir>` saves a screenshot of each.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { NARRATION_TEXT } from "./fixture/narration";
import { exitApp, launchApp } from "./harness";

async function capture(page: Page, name: string) {
	const directory = process.env.OMP_GUI_ANSWER_VISIBLE_SHOTS;
	if (!directory) return;
	await fs.mkdir(directory, { recursive: true });
	await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

test("text a reply writes beside its tool calls stays visible in the chat, live, finished and after a reload", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-narration-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({ project, desktop, agent, profile });
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea").first();
		const narration = page.locator(".omp-transcript-row").getByText(NARRATION_TEXT, { exact: true });

		await input.fill("fixture narrated");
		await input.press("Enter");
		const answer = page.getByText("Narrated run finished.", { exact: true });
		await expect(answer).toBeVisible({ timeout: 30_000 });
		await capture(page, "finished");
		await expect(narration).toBeVisible();
		await expect(narration).toHaveCount(1);
		// In the order it was written: before the final answer.
		const narrationBox = await narration.boundingBox();
		const answerBox = await answer.boundingBox();
		expect(narrationBox && answerBox && narrationBox.y < answerBox.y).toBe(true);

		await page.reload();
		await expect(page.getByText("Narrated run finished.", { exact: true })).toBeVisible({ timeout: 30_000 });
		await capture(page, "reloaded");
		await expect(narration).toBeVisible();

		// Live: the second call is still running when the text has to be there.
		await input.fill("fixture narrated live");
		await input.press("Enter");
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(".omp-work-narrative").filter({ hasText: "Running the tests" })).toBeVisible({
			timeout: 30_000,
		});
		await capture(page, "live");
		await expect(narration).toHaveCount(2);
		await expect(narration.last()).toBeVisible();
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
