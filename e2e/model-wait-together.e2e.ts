import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp } from "./harness";

// Several sessions of this computer waiting on one provider at once: each one's cue says the wait is shared (the
// provider's queue, not that session), and takes it back once one of them is answered. The counting rule is
// src/main/model-wait-count.test.ts, the cue's words src/renderer/lib/model-wait.test.ts and the chip's component test;
// this runs main's tracker, the push and the page. The fake omp holds two tabs' requests unanswered
// (`fixture:model-request:sent:<provider>`); the 30 s the cue waits before naming a wait are real time.
test.setTimeout(120_000);

let app: ElectronApplication;
let page: Page;
let profile: string;

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-model-wait-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({ project, desktop, agent, profile });
	page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const tabs = () => page.evaluate(() => window.omp.tabs.list());

async function fixtureCommand(tabId: string, command: string): Promise<void> {
	const response = await page.evaluate(
		([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }),
		[tabId, command] as const,
	);
	expect(response).toMatchObject({ success: true });
}

async function startRun(): Promise<void> {
	await page.locator("textarea").first().fill("fixture running");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
}

test("sessions waiting on one provider together say so, and stop when one is answered", async () => {
	const first = (await tabs()).find(tab => tab.active)?.tabId;
	if (!first) throw new Error("No active tab");
	await startRun();
	const before = (await tabs()).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
	const second = (await tabs()).find(tab => !before.includes(tab.tabId))?.tabId;
	if (!second) throw new Error("No second tab");
	await expect.poll(async () => (await tabs()).find(tab => tab.tabId === second)?.status).toBe("ready");
	await expect.poll(async () => (await tabs()).find(tab => tab.active)?.tabId).toBe(second);
	await startRun();

	await fixtureCommand(first, "fixture:model-request:sent:anthropic");
	await fixtureCommand(second, "fixture:model-request:sent:anthropic");
	const cue = page.getByText(/Waiting for the model's response/).first();
	// Named alone first (30 s), then shared once the second request has waited as long.
	await expect(cue).toBeVisible({ timeout: 45_000 });
	await expect(cue).toContainText("2 sessions waiting together", { timeout: 15_000 });
	await page.screenshot({ path: test.info().outputPath("model-wait-together.png") });

	// One answered: the other waits alone again.
	await fixtureCommand(first, "fixture:model-request:answered");
	await expect(page.getByText(/sessions waiting together/)).toHaveCount(0, { timeout: 10_000 });
	await expect(page.getByText(/Waiting for the model's response · \d+(s|m)$/).first()).toBeVisible();
});
