/**
 * Settings › General › Profile end to end on the fake omp: the name and the
 * development experience save to prefs `userProfile`, reach the live tab's
 * gui-bridge as `user_profile_set`, and are pushed again when a restarted
 * omp connects. Captures in light/dark × en/ko, plus a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";
import { resize } from "./shell-capture";

for (const [language, theme] of [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const) {
	test(`profile name and experience reach the live session (${language} ${theme})`, async () => {
		test.setTimeout(90_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-profile-${language}-${theme}-`));
		const desktop = path.join(root, "desktop");
		const project = path.join(root, "project");
		const agent = path.join(root, "agent");
		const record = path.join(root, "rpc.jsonl");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile: root,
			env: {
				OMP_GUI_TEST_RECORD: record,
			},
		});
		const page = await app.firstWindow();
		const profileSets = async () =>
			(await fs.readFile(record, "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line))
				.filter(frame => frame.type === "user_profile_set")
				.map(({ name, experience }) => ({ name, experience }));
		const shot = (name: string) =>
			page.screenshot({
				path: test.info().outputPath(`profile-${language}-${theme}-${name}.png`),
				scale: "css",
				animations: "disabled",
			});
		try {
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status)
				.toBe("ready");
			// An empty profile is still pushed on connect, so a cleared one clears.
			await expect.poll(profileSets).toEqual([{ name: "", experience: null }]);

			await page.keyboard.press("ControlOrMeta+Comma");
			const settings = page.locator("[data-settings-page]");
			await settings.locator('[data-settings-section="general"]').click();
			const name = settings.locator("#setting-gui-profileName input");
			const experience = settings.locator("#setting-gui-profileExperience select");
			await expect(name).toBeEnabled();
			await name.fill("Sam");
			await name.press("Enter");
			await experience.selectOption("vibe-coder");
			await expect.poll(profileSets).toEqual([
				{ name: "", experience: null },
				{ name: "Sam", experience: null },
				{ name: "Sam", experience: "vibe-coder" },
			]);
			expect(await page.evaluate(() => window.omp.prefs.get("userProfile"))).toEqual({
				name: "Sam",
				experience: "vibe-coder",
			});
			await settings.locator("#setting-gui-profileName").scrollIntoViewIfNeeded();
			await shot("settings");

			// Too long to be a form of address: says so and saves nothing.
			await name.fill("x".repeat(65));
			await name.press("Enter");
			await expect(settings.locator("#setting-gui-profileName")).toContainText("64");
			await shot("too-long");
			expect(await profileSets()).toHaveLength(3);
			await name.fill("Sam");
			await name.press("Enter");

			if (language === "en" && theme === "light") {
				await resize(app, 560, 760);
				await settings.locator("#setting-gui-profileName").scrollIntoViewIfNeeded();
				await shot("narrow");
			}

			// A restarted omp gets the stored profile again when its bridge connects.
			await page.keyboard.press("Escape");
			await page.evaluate(() => window.omp.sidecar.restart({}));
			await expect
				.poll(async () => (await profileSets()).slice(3))
				.toEqual([{ name: "Sam", experience: "vibe-coder" }]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
