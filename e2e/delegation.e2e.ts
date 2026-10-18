/**
 * Composer delegation chip end to end on the fake omp: it lists every
 * strength, a pick reaches the tab's gui-bridge as `modes.set_delegation` and
 * prefs `delegationMode`, and a restarted omp starts on that strength
 * (`OMP_GUI_DELEGATION`, which the fake omp reports back). Captures in
 * light/dark × en/ko, plus a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp, recordsOfType, variants } from "./harness";
import { resize } from "./shell-capture";

for (const [language, theme] of variants([
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const)) {
	test(`delegation chip switches the live tab and new spawns (${language} ${theme})`, async () => {
		test.setTimeout(90_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-delegation-${language}-${theme}-`));
		const desktop = path.join(root, "desktop");
		const project = path.join(root, "project");
		const agent = path.join(root, "agent");
		const record = path.join(root, "rpc.jsonl");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
		const app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_RECORD: record } });
		const page = await app.firstWindow();
		const sets = async () => (await recordsOfType(record, "modes.set_delegation")).map(frame => frame.mode);
		const shot = (name: string) =>
			page.screenshot({
				path: test.info().outputPath(`delegation-${language}-${theme}-${name}.png`),
				scale: "css",
				animations: "disabled",
			});
		try {
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status)
				.toBe("ready");
			// Delegation is a section of the Run popover now (one chip for mode, thinking, approval, delegation).
			const chip = page.locator("[data-run-settings-trigger]");
			await expect(chip).toBeVisible();
			await chip.click();
			const options = page.locator("[data-delegation-option]");
			await expect(options).toHaveCount(5);
			await expect(page.locator('[data-delegation-option="default"]')).toHaveAttribute("aria-checked", "true");
			await shot("menu");
			await page.locator('[data-delegation-option="swarm"]').click();
			await expect.poll(sets).toEqual(["swarm"]);
			await expect.poll(() => page.evaluate(() => window.omp.prefs.get("delegationMode"))).toBe("swarm");
			// The Run popover stays open after a pick; the chip's name carries the strength.
			await expect(chip).toHaveAttribute("aria-label", language === "en" ? /Swarm/ : /스웜/);
			await shot("swarm");

			// A restarted omp starts on the remembered strength (spawn env), with no set call.
			await page.evaluate(() => window.omp.sidecar.restart({}));
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status)
				.toBe("ready");
			await page.keyboard.press("Escape");
			await expect(options).toHaveCount(0);
			await chip.click();
			await expect(page.locator('[data-delegation-option="swarm"]')).toHaveAttribute("aria-checked", "true");
			expect(await sets()).toEqual(["swarm"]);
			await page.locator('[data-delegation-option="solo"]').click();
			await expect.poll(sets).toEqual(["swarm", "solo"]);

			if (language === "en" && theme === "light") {
				await resize(app, 560, 760);
				await page.keyboard.press("Escape");
				await chip.click();
				await expect(options).toHaveCount(5);
				await shot("narrow");
				await page.keyboard.press("Escape");
			}
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
