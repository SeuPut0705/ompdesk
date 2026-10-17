/**
 * "Branch to a new tab from here" on the user's own prompt, on the fake omp with stock-shaped session files.
 *
 * Reported on v0.35.1: a branch from a prompt copied the conversation through that prompt, so the new tab held a
 * prompt nothing ever sent (no reply, nothing running). After the next restart stock journaled it as a turn cut
 * off ("Previous OMP process exited before completing the turn."), and it was never continued: nothing had been
 * running there. A branch from a prompt now starts over like stock `branch`: the new session ends with the reply
 * before the prompt, and the prompt waits in the new tab's composer.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

test("a branch from a prompt ends before it and puts the prompt in the new tab's composer", async () => {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-branch-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator(".omp-composer-input").first();
		const replies = page.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" });
		for (const [index, prompt] of ["first question", "second question"].entries()) {
			await input.fill(prompt);
			await input.press("Enter");
			await expect(replies).toHaveCount(index + 1);
		}

		const prompt = page.locator(".omp-user-turn").filter({ hasText: "second question" });
		await prompt.hover();
		await prompt.getByRole("button", { name: "Branch to a new tab from here" }).click();

		await expect.poll(() => page.evaluate(() => window.omp.tabs.list()), { timeout: 60_000 }).toHaveLength(2);
		const tabs = await page.evaluate(() => window.omp.tabs.list());
		const branch = tabs.find(tab => tab.active);
		expect(branch?.sessionPath).toBeTruthy();
		// The prompt waits in the new tab's composer, unsent; the transcript ends with the reply before it.
		await expect(input).toHaveValue("second question");
		await expect(page.locator(".omp-user-turn").filter({ hasText: "first question" })).toHaveCount(1);
		await expect(page.locator(".omp-user-turn").filter({ hasText: "second question" })).toHaveCount(0);
		// On disk too: the copy's last message is the reply, so a restart finds no unsent prompt to run.
		const lines = (await fs.readFile(branch?.sessionPath ?? "", "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { type: string; message?: { role: string } });
		expect(lines.filter(line => line.type === "message").at(-1)?.message?.role).toBe("assistant");
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
