import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// The Windows CI e2e job runs only this (`--grep @smoke`): launch on the fake
// omp, gui-bridge over the named pipe, a new tab, one prompt round-trip, and
// the settings window.
test("@smoke app boots on omp, connects the bridge, opens a tab, answers a prompt, opens settings", async () => {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-smoke-"));
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
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		// Settings are served by the gui-bridge, so this answers only over the pipe.
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["compaction.enabled"])))
			.toMatchObject({ success: true });

		await page.keyboard.press("ControlOrMeta+t");
		const tabs = page.locator('[role="tablist"] [role="tab"][data-status]');
		await expect(tabs).toHaveCount(2);
		// An idle tab shows no status icon; readiness is the chip's data-status.
		await expect(tabs.last()).toHaveAttribute("data-status", "ready", { timeout: 60_000 });

		await page.locator("textarea").first().fill("smoke hello");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await expect(page.locator("[data-transcript-kind]").filter({ hasText: "Local fixture reply" })).toHaveCount(1);

		await page.keyboard.press("ControlOrMeta+Comma");
		const settings = page.locator("[data-settings-page]");
		await expect(settings.locator('[data-settings-section="appearance"]')).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
