/**
 * In-app GitHub sign-in end to end: a fake gh (src/main/github-auth/test-fake-gh.ts)
 * first on PATH, run by `gh auth login --web` inside the installed omp's real
 * stock PtySession, on a temp HOME and GIT_CONFIG_GLOBAL (the user's gh login
 * and git config are never read or written).
 *
 * The first run was left at the GitHub step before this "relaunch", so it
 * resumes there; the device code shows, gh's "Press Enter to open" waits for
 * "Copy code & open GitHub", the approval signs in and fills the empty Git
 * identity; Esc asks before leaving and ⌘/Ctrl+Enter finishes setup; Settings ›
 * General then shows the account and signs it out. Captures in light/dark × en/ko.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { seedFakeGh, writeFakeGh } from "../src/main/github-auth/test-fake-gh";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

for (const [language, theme] of [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const) {
	test(`GitHub sign-in from the resumed first run (${language} ${theme})`, async () => {
		test.skip(process.platform === "win32", "the fake gh is a shebang script; PATH lookup wants gh.exe on Windows");
		test.setTimeout(120_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-github-${language}-${theme}-`));
		const home = path.join(root, "home");
		const desktop = path.join(root, "desktop");
		const project = path.join(root, "project");
		const agent = path.join(root, "agent");
		await Promise.all([fs.mkdir(home), fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true, firstRunStep: "github" }),
		);
		const gh = await writeFakeGh(root);
		const ghState = path.join(root, "gh-state.json");
		await seedFakeGh(ghState, []);
		const gitConfig = path.join(home, ".gitconfig");
		await fs.writeFile(gitConfig, "");
		const bin = await fixtureOmp(root);
		// Fake agent, real installed stock PTY.
		const natives =
			process.env.OMP_GUI_TEST_NATIVES ||
			path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
		await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "dir");
		const env = {
			...process.env,
			PATH: [path.dirname(gh), process.env.PATH].join(path.delimiter),
			HOME: home,
			GIT_CONFIG_GLOBAL: gitConfig,
			GIT_CONFIG_NOSYSTEM: "1",
			FAKE_GH_STATE: ghState,
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: "omp-config",
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: bin,
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
			env,
		});
		const shot = (name: string) =>
			page.screenshot({
				animations: "disabled",
				path: test.info().outputPath(`github-${language}-${theme}-${name}.png`),
			});
		const page = await app.firstWindow();
		try {
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			await app.evaluate(({ BrowserWindow, shell }) => {
				BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 900);
				const opened: string[] = [];
				Object.assign(globalThis, { openedUrls: opened });
				shell.openExternal = async (url: string) => {
					opened.push(url);
				};
			});
			await page.waitForFunction(() => window.omp?.rpc != null);

			// Resumed at the GitHub step after the relaunch.
			const step = page.locator('[data-first-run-step="github"]');
			await expect(step).toBeVisible({ timeout: 30_000 });
			const card = step.getByTestId("github-sign-in");
			await expect(card).toHaveAttribute("data-github-phase", "signed-out");
			await expect(card).toContainText("gh 2.62.0");
			await shot("1-signed-out");

			await card.getByTestId("github-sign-in-start").click();
			const code = card.getByTestId("github-device-code");
			await expect(code).toContainText("ABCD-1234", { timeout: 30_000 });
			// gh waits at "Press Enter to open" until the user opened GitHub.
			expect(existsSync(`${ghState}.git-answered`)).toBe(true);
			expect(existsSync(`${ghState}.opened`)).toBe(false);
			await shot("2-code");

			await card.getByTestId("github-open").click();
			await expect(card).toHaveAttribute("data-github-phase", "signed-in", { timeout: 30_000 });
			expect(await app.evaluate(() => Reflect.get(globalThis, "openedUrls"))).toEqual([
				"https://github.com/login/device",
			]);
			await expect(card.getByTestId("github-identity")).toContainText("The Octocat <octocat@example.com>");
			const config = await fs.readFile(gitConfig, "utf8");
			expect(config).toContain("name = The Octocat");
			expect(config).toContain("email = octocat@example.com");
			await shot("3-signed-in");

			// Esc asks before leaving; staying keeps the step.
			await page.locator("body").press("Escape");
			const dialog = page.getByRole("dialog");
			await expect(dialog).toBeVisible();
			await expect
				.poll(() => page.evaluate(() => document.getAnimations().every(a => a.playState !== "running")))
				.toBe(true);
			await shot("4-leave-confirm");
			await page.keyboard.press("Escape");
			await expect(dialog).toHaveCount(0);
			await expect(step).toBeVisible();

			// ⌘/Ctrl+Enter finishes setup, and the resume marker goes with it.
			await page.locator("body").press("ControlOrMeta+Enter");
			await expect(step).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.omp.prefs.get("firstRunStep"))).toBeUndefined();

			const settings = page.locator("[data-settings-page]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			const section = settings.locator("#setting-github-account");
			await section.scrollIntoViewIfNeeded();
			await expect(section.getByTestId("github-sign-in")).toHaveAttribute("data-github-phase", "signed-in");
			await shot("5-settings");
			await section.getByTestId("github-sign-out").click();
			await expect(section.getByTestId("github-sign-in")).toHaveAttribute("data-github-phase", "signed-out");
			expect(JSON.parse(await fs.readFile(ghState, "utf8")).active).toBeNull();
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
