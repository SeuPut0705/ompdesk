/**
 * Settings captures: every section in light/dark × en/ko, wide and narrow (chip nav).
 * Runs only with OMPDESK_SETTINGS_SHOTS=<dir> (before/after comparisons of the compact redesign).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

const SHOTS = process.env.OMPDESK_SETTINGS_SHOTS;
test.skip(!SHOTS, "set OMPDESK_SETTINGS_SHOTS=<dir> to capture");

const SIZES = { wide: [1280, 2600], narrow: [800, 2600] } as const;

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`settings captures (${language} ${theme})`, async () => {
			test.setTimeout(300_000);
			const dir = SHOTS ?? "";
			await fs.mkdir(dir, { recursive: true });
			const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-shots-"));
			const [desktop, project, agent] = ["desktop", "project", "agent"].map(name => path.join(profile, name));
			await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
			await fs.writeFile(
				path.join(desktop, "prefs.json"),
				JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
			);
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
					.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, {
						timeout: 60_000,
					})
					.toBe("ready");
				const settings = page.locator("[data-settings-page]");
				await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
				const ids = await settings
					.locator("[data-settings-section]")
					.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section") ?? ""));
				for (const [size, [width, height]] of Object.entries(SIZES)) {
					await app.evaluate(
						({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
						[width, height],
					);
					await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
					for (const id of ids) {
						await settings.locator(`[data-settings-section="${id}"]`).click();
						await expect(settings.locator(".settings-content .animate-spin")).toHaveCount(0, { timeout: 30_000 });
						await page.waitForTimeout(300);
						await page.mouse.move(1, 1);
						await settings.screenshot({
							animations: "disabled",
							path: path.join(dir, `${id}-${language}-${theme}-${size}.png`),
						});
					}
				}
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true });
			}
		});
