import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

test("bounded history rendering and input responsiveness across 5k, 20k and 50k messages", async () => {
	test.skip(process.env.OMP_GUI_PERFORMANCE !== "1", "Explicit local performance audit");
	test.setTimeout(900_000);
	const results: object[] = [];
	const roots = [
		{ name: "candidate", root: process.cwd() },
		...(process.env.OMP_GUI_BASELINE_DIR ? [{ name: "baseline", root: process.env.OMP_GUI_BASELINE_DIR }] : []),
	];
	for (const count of [5_000, 20_000, 50_000])
		for (let run = 0; run < 3; run++)
			for (const subject of run % 2 ? [...roots].reverse() : roots) {
				const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-perf-"));
				const project = path.join(profile, "project"),
					desktop = path.join(profile, "desktop"),
					agent = path.join(profile, "agent");
				await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
				await fs.writeFile(
					path.join(desktop, "prefs.json"),
					JSON.stringify({ language: "en", firstRunComplete: true }),
				);
				const env = {
					...process.env,
					PI_CODING_AGENT_DIR: agent,
					PI_CONFIG_DIR: path.relative(os.homedir(), profile),
					OMP_PROFILE: "",
					PI_PROFILE: "",
					OMP_GUI_OMP: await fixtureOmp(profile),
					OMP_GUI_TEST_HISTORY: String(count),
				};
				Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
				const started = performance.now();
				const app = await electron.launch({
					args: [path.join(subject.root, "out/main/index.js"), project, `--user-data-dir=${desktop}`],
					env,
				});
				const page = await app.firstWindow();
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				try {
					await expect(page.locator("[data-transcript-kind]").first()).toBeVisible({ timeout: 60000 });
					const startupMs = performance.now() - started;
					const mountedRows = await page.locator("[data-transcript-kind]").count();
					expect(mountedRows).toBeLessThan(150);
					const input = page.locator("textarea").first();
					await input.click();
					const inputMs: number[] = [];
					for (const character of "abcdefghijklmnopqrst") {
						const before = performance.now();
						await page.keyboard.type(character);
						await page.evaluate(() =>
							(() => {
								const { promise, resolve } = Promise.withResolvers<void>();
								requestAnimationFrame(() => resolve());
								return promise;
							})(),
						);
						inputMs.push(performance.now() - before);
					}
					await expect(input).toHaveValue("abcdefghijklmnopqrst");
					const switchMs: number[] = [];
					if (count === 5000 && run === 0) {
						await input.fill("fixture stream");
						await input.press("Enter");
						await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
						for (let index = 1; index < 5; index++) {
							await page.keyboard.press("ControlOrMeta+t");
							await expect(page.locator('[role="tablist"] [role="tab"][data-status]')).toHaveCount(index + 1);
							await expect(page.locator("[data-transcript-kind]").first()).toBeVisible();
						}
						for (let index = 0; index < 20; index++) {
							const before = performance.now();
							await page
								.locator('[role="tablist"] [role="tab"][data-status]')
								.nth(index % 5)
								.click();
							await expect(page.locator("textarea").first()).toBeEnabled();
							await page.evaluate(() =>
								(() => {
									const { promise, resolve } = Promise.withResolvers<void>();
									requestAnimationFrame(() => resolve());
									return promise;
								})(),
							);
							switchMs.push(performance.now() - before);
						}
					}
					const item = { subject: subject.name, count, run, startupMs, mountedRows, inputMs, switchMs, errors };
					results.push(item);
					await fs.writeFile("test-results/performance.json", JSON.stringify(results, null, 2));
					expect(errors).toEqual([]);
				} finally {
					await exitApp(app);
					await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
				}
			}
});
