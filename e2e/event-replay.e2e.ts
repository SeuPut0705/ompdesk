/**
 * The event pipeline under late and duplicated frames: the fake omp sends every message and
 * tool frame a second time behind the next one (`OMP_GUI_TEST_REPLAY_FRAMES`), and main holds
 * each batch for 400 ms (`OMP_GUI_TEST_BATCH_INTERVAL_MS`), so transcript snapshots taken on a
 * tab switch overtake the frames they already hold. The run must still end as it ran: every
 * step settled, each command counted once, the outcome shown.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

test("a work run whose frames arrive late and twice ends without phantom or duplicate steps", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-event-replay-"));
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
		OMP_GUI_TEST_REPLAY_FRAMES: "1",
		OMP_GUI_TEST_BATCH_INTERVAL_MS: "400",
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
		await input.fill("fixture work view");
		await input.press("Enter");
		await expect(page.locator(".omp-work-sub")).toContainText("Preparing the workspace");
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
		if (!tab) throw new Error("Missing work tab");
		const advance = () =>
			page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:work-next" }), tab);
		for (let index = 0; index < 4; index++) await advance();
		await expect(page.locator(".omp-work-card-button")).toHaveCount(2);
		// Away and back mid-run: the return loads a snapshot while the held batch still carries
		// the frames it holds, and their replays follow.
		await page.keyboard.press("ControlOrMeta+t");
		await expect(page.locator(".omp-work-card")).toHaveCount(0);
		await advance();
		await advance();
		await page.locator(`[data-session-path="tab:${tab}"]`).click();
		await expect(page.locator(".omp-work-catch-up")).toContainText(/steps? advanced while you were away/);
		await page.locator(".omp-work-catch-up").click();
		// Each step taken while frames of the last one are still in flight.
		for (let index = 0; index < 8; index++) await advance();

		await expect(page.locator(".omp-work-outcome")).toBeVisible();
		// No step is left running behind the outcome, and nothing counts twice.
		await expect(page.locator(".omp-execution-group-header[aria-label*='running']")).toHaveCount(0);
		await expect(page.locator(".omp-execution-group-summary").last()).toContainText("3 commands");
		await page.locator(".omp-work-outcome summary").click();
		await expect(page.locator(".omp-work-outcome li").filter({ hasText: "wc -l src/workspace.ts" })).toHaveCount(2);
		await expect(page.getByText("Live workspace finished", { exact: true })).toHaveCount(1);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
