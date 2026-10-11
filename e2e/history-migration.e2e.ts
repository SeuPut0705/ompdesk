import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// A profile from before stock-backed history still holds `inputHistory` in
// prefs.json. The first ready tab moves it into stock history and clears the
// key through the real electron-store, then ↑ recalls it. The clear used to
// throw ("Use `delete()` to clear values"), so the move retried on every launch
// and the composer's ↑ history never loaded.
test("legacy prompt history migrates once and is recalled with ↑", async () => {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-history-migration-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	// realpath: the tab's cwd is the resolved path (/var → /private/var on macOS).
	const cwd = await fs.realpath(project);
	const prefsFile = path.join(desktop, "prefs.json");
	await fs.writeFile(
		prefsFile,
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			// The shape real profiles hold: newest first, each with its workspace.
			inputHistory: [
				{ prompt: "newest legacy prompt", cwd, ts: 2 },
				{ prompt: "older legacy prompt", cwd, ts: 1 },
			],
		}),
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
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await expect
			.poll(async () => "inputHistory" in JSON.parse(await fs.readFile(prefsFile, "utf8")), { timeout: 15_000 })
			.toBe(false);
		const composer = page.locator(".omp-composer-box textarea").first();
		await composer.click();
		await expect
			.poll(
				async () => {
					await composer.press("ArrowUp");
					const value = await composer.inputValue();
					await composer.fill("");
					return value;
				},
				{ timeout: 15_000 },
			)
			.toBe("newest legacy prompt");
		const logFile = path.join(desktop, "logs", "gui-runtime.jsonl");
		const log = await fs.readFile(logFile, "utf8").catch(() => "");
		expect(log).not.toContain("Use `delete()` to clear values");
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
