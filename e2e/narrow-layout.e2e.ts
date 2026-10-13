import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// At the smallest window OMPdesk allows (800×640, sidebar open) the settings
// nav labels read in full and no settings section or settings tab scrolls
// sideways: long paths and tab rows wrap inside the column. (A real session's
// stats at this width are checked in real-core.e2e.ts, which has a real id.)

/** Width by which a scroll container's content exceeds its box (0 = fits). */
const sideways = (scroller: Locator) => scroller.evaluate(element => element.scrollWidth - element.clientWidth);

test("settings fit the smallest window", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-narrow-layout-"));
	const [desktop, project, agent] = ["desktop", "project", "agent"].map(name => path.join(profile, name));
	await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
	execFileSync("git", ["init", "--quiet"], { cwd: project });
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
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 640));
		await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800);

		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		const nav = settings.locator("[data-settings-section]");
		expect
			.soft(
				await nav.evaluateAll(buttons =>
					buttons.filter(button => button.scrollWidth > button.clientWidth).map(button => button.textContent),
				),
			)
			.toEqual([]);

		const content = settings.locator(".settings-content");
		const overflowing: string[] = [];
		const ids = await nav.evaluateAll(buttons =>
			buttons.map(button => button.getAttribute("data-settings-section") ?? ""),
		);
		for (const id of ids) {
			await settings.locator(`[data-settings-section="${id}"]`).click();
			await expect(content.locator(".animate-spin")).toHaveCount(0, { timeout: 30_000 });
			if ((await sideways(content)) > 0) overflowing.push(id);
			const tabs = content.getByRole("tab");
			for (let index = 0; index < (await tabs.count()); index++) {
				await tabs.nth(index).click();
				await expect(content.locator(".animate-spin")).toHaveCount(0, { timeout: 30_000 });
				if ((await sideways(content)) > 0) overflowing.push(`${id} › ${await tabs.nth(index).textContent()}`);
			}
		}
		expect.soft(overflowing).toEqual([]);
		await page.keyboard.press("Escape");
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true });
	}
});
