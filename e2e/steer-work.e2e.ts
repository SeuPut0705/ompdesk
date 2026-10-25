import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

const STEER = "Also split the CI timing";

/** One turn is one work card: a mid-run steer joins it, live and after a reload. */
async function expectOneCard(page: Page) {
	await expect(page.locator(".omp-execution-group")).toHaveCount(1);
	const card = page.locator(".omp-execution-group");
	await expect(card.locator("[data-steer]")).toContainText(STEER);
	await expect(card.locator(".omp-work-card-button")).toHaveCount(2);
	await expect(card.locator(".omp-work-card-button").filter({ hasText: "LaneRace" })).toHaveCount(1);
	await expect(card.locator(".omp-work-card-button").filter({ hasText: "CiSpeed" })).toHaveCount(1);
	// The steer lives in the card, never as a separate bubble splitting the turn.
	await expect(page.locator(".omp-user-bubble").filter({ hasText: STEER })).toHaveCount(0);
}

test("a steer sent mid-run stays inside the turn's one work card with every agent's lane", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-steer-work-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea").first();
		const capture = async (state: string) => {
			const directory = process.env.OMP_GUI_WORK_SCREENSHOTS;
			if (!directory) return;
			await fs.mkdir(directory, { recursive: true });
			for (const [theme, label] of [
				["light", "OMPdesk Light"],
				["dark", "OMPdesk Dark"],
			]) {
				const draft = await input.inputValue();
				await input.fill("/theme");
				await page.getByRole("button", { name: "Send", exact: true }).click();
				const dialog = page.getByRole("dialog");
				await dialog.getByPlaceholder("Search themes…").fill(label);
				await dialog.locator("[data-theme-entry]").filter({ hasText: label }).click();
				await expect(dialog).toHaveCount(0);
				await page.getByRole("button", { name: "Close", exact: true }).evaluateAll(buttons => {
					for (const button of buttons) if (button instanceof HTMLButtonElement) button.click();
				});
				await expect(page.locator(".omp-toast-in, .omp-toast-out")).toHaveCount(0);
				await input.fill(draft);
				await page.screenshot({
					path: path.join(directory, `steer-${state}-${theme}.png`),
					animations: "disabled",
					scale: "css",
				});
			}
		};
		await input.fill("fixture steer work");
		await input.press("Enter");
		await expect(page.locator(".omp-work-card-button").filter({ hasText: "LaneRace" })).toHaveCount(1);
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
		if (!tab) throw new Error("Missing steer tab");
		const fixture = (command: string) =>
			page.evaluate(([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }), [
				tab,
				command,
			] as const);

		// The composer steers the running turn; stock queues it until the loop takes it.
		await input.fill(STEER);
		await input.press("Enter");
		await expect(page.locator("[data-queue-pill]")).toContainText("1 queued");
		await page.locator("[data-queue-pill]").click();
		await expect(page.locator("[data-queue-popover]")).toContainText(STEER);
		await fixture("fixture:steer-next");
		await expect(page.locator("[data-queue-pill]")).toHaveCount(0);
		await expectOneCard(page);
		await expect(page.locator('.omp-live-step[data-state="running"]:not([data-nested="true"])')).toHaveCount(1);
		await capture("live");

		await fixture("fixture:steer-finish");
		await expect(page.locator('.omp-live-step[data-outcome="true"]')).toBeVisible();
		await expectOneCard(page);
		await expect(page.locator('.omp-live-step[data-state="running"]')).toHaveCount(0);
		const summary = page.locator(".omp-execution-group-header");
		const finishedSummary = await summary.getAttribute("aria-label");
		// Whole lane rows: name, conclusion and duration, each from stock's transcript records.
		const lanes = page.locator(".omp-work-card-button");
		await expect(lanes.filter({ hasText: "LaneRace" })).toContainText("The lane conclusion race is fixed.");
		await expect(lanes.filter({ hasText: "LaneRace" })).toContainText("2.4s");
		const finishedLanes = await lanes.allTextContents();
		await capture("finished");

		// A reloaded window hydrates the same single card from the transcript, with the same head.
		await page.reload();
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await expectOneCard(page);
		await expect(page.locator(".omp-work-head [data-incoming] > .omp-work-narrative")).toHaveText("Work complete");
		await expect(summary).toHaveAttribute("aria-label", finishedSummary ?? "");
		await expect(lanes).toHaveText(finishedLanes);
		await capture("hydrated");
		const directory = process.env.OMP_GUI_WORK_SCREENSHOTS;
		if (directory) {
			await page.evaluate(() => window.omp.prefs.set("language", "ko"));
			await page.reload();
			await expectOneCard(page);
			await expect(page.locator(".omp-work-head [data-incoming] > .omp-work-narrative")).toHaveText(
				"작업을 완료했어요",
			);
			await page.screenshot({
				path: path.join(directory, "steer-hydrated-ko-dark.png"),
				animations: "disabled",
				scale: "css",
			});
		}
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
