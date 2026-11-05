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

test("the text shows once after coming back to a run that went on with a reply that only calls tools", async () => {
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
		const runTab = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
		const pane = page.locator(`.omp-session-pane[data-tab-id="${runTab}"]`);
		const narration = pane.locator(".omp-transcript-row").getByText(NARRATION_TEXT, { exact: true });
		const field = pane.locator(".omp-composer-input");
		const activeTab = async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;

		// The reply's text streams in; the reply is still open (its calls not out yet).
		await field.fill("fixture narrated then work");
		await field.press("Enter");
		await expect(narration).toHaveCount(1, { timeout: 30_000 });
		// Another tab is in front while the reply ends, its call runs, a reply that only calls a tool runs, and the
		// next model call starts: this tab hears none of it.
		await page.getByRole("button", { name: "New agent session here" }).first().click();
		await expect.poll(activeTab).not.toBe(runTab);
		const awayTab = (await activeTab()) ?? "";
		// A draft keeps the new tab when the run's tab comes back to the front (an empty one left is closed).
		await page.locator(`.omp-session-pane[data-tab-id="${awayTab}"] .omp-composer-input`).fill("a draft");
		await page.evaluate(
			id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:narrated:resume" }),
			runTab,
		);
		await expect
			.poll(
				async () =>
					JSON.stringify(
						(
							await page.evaluate(
								id =>
									window.omp.rpc.commandForTab(id, { type: "get_transcript_page", fromEnd: true, limit: 10 }),
								runTab,
							)
						).data ?? null,
					).includes("narrated-after-"),
				{ timeout: 30_000 },
			)
			.toBe(true);

		// Back on the run (⌃⇥: the tab used before this one): the text once, under the card holding its call, and the
		// tool-only reply's card under it.
		await page.keyboard.down("Control");
		await page.keyboard.press("Tab");
		await expect(page.getByRole("listbox", { name: "Open tabs, most recent first" })).toBeVisible();
		await page.keyboard.up("Control");
		await expect(pane).toHaveAttribute("data-active", "true");
		await expect(pane.locator(".omp-work-narrative").filter({ hasText: "Reviewing the diff" })).toBeVisible({
			timeout: 30_000,
		});
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
		await capture(page, "then-work-back");
		await expect(narration).toHaveCount(1);
		const textBox = await narration.boundingBox();
		const cardBox = await pane.locator(".omp-work-narrative").filter({ hasText: "Reviewing the diff" }).boundingBox();
		expect(textBox && cardBox && textBox.y < cardBox.y).toBe(true);

		await page.reload();
		await expect(narration).toHaveCount(1, { timeout: 30_000 });
		await capture(page, "then-work-reloaded");
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
