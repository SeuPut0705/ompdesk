import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

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
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
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
				["light", "Porcelain"],
				["dark", "Graphite"],
			]) {
				const draft = await input.inputValue();
				await input.fill("/theme");
				await page.getByRole("button", { name: "Send", exact: true }).click();
				const dialog = page.getByRole("dialog");
				await dialog.getByPlaceholder("Search themes…").fill(label);
				await dialog.locator("button[aria-pressed]").filter({ hasText: label }).click();
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
		await expect(page.locator(".omp-composer-queue")).toContainText(STEER);
		await fixture("fixture:steer-next");
		await expect(page.locator(".omp-composer-queue")).toHaveCount(0);
		await expectOneCard(page);
		await expect(page.locator('.omp-live-step[data-state="running"]:not([data-nested="true"])')).toHaveCount(1);
		await capture("live");

		await fixture("fixture:steer-finish");
		await expect(page.locator(".omp-work-outcome")).toBeVisible();
		await expectOneCard(page);
		await expect(page.locator('.omp-live-step[data-state="running"]')).toHaveCount(0);
		await capture("finished");

		// A reloaded window hydrates the same single card from the transcript.
		await page.reload();
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await expectOneCard(page);
		await capture("hydrated");
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
