/**
 * In-app GitHub sign-in end to end: a fake gh (src/main/github-auth/test-fake-gh.ts)
 * first on PATH, run by `gh auth login --web` inside the installed omp's real
 * stock PtySession, on a temp HOME and GIT_CONFIG_GLOBAL (the user's gh login
 * and git config are never read or written).
 *
 * Settings › General shows the sign-in card; the device code shows, gh's "Press
 * Enter to open" waits for "Copy code & open GitHub", the approval signs in and
 * fills the empty Git identity, and sign-out clears the account. Captures in
 * light/dark × en/ko.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { seedFakeGh } from "../src/main/github-auth/test-fake-gh";
import { fixtureGhDir } from "./fixture/fake-gh-install";
import { exitApp, fixtureOmp, pressShortcutUntilVisible, variants } from "./harness";

for (const [language, theme] of variants([
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const)) {
	test(`GitHub sign-in from Settings › General (${language} ${theme})`, async () => {
		test.setTimeout(120_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-github-${language}-${theme}-`));
		const home = path.join(root, "home");
		const desktop = path.join(root, "desktop");
		const project = path.join(root, "project");
		const agent = path.join(root, "agent");
		await Promise.all([fs.mkdir(home), fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
		const ghDir = await fixtureGhDir(root);
		const ghState = path.join(root, "gh-state.json");
		await seedFakeGh(ghState, []);
		const gitConfig = path.join(home, ".gitconfig");
		await fs.writeFile(gitConfig, "");
		const bin = await fixtureOmp(root);
		// Fake agent, real installed stock PTY.
		const natives =
			process.env.OMP_GUI_TEST_NATIVES ||
			path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
		await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "junction");
		const env = {
			...process.env,
			PATH: [ghDir, process.env.PATH].join(path.delimiter),
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
			args: [
				path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
				project,
				`--user-data-dir=${desktop}`,
			],
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

			// Settings › General holds the GitHub sign-in.
			const settings = page.locator("[data-settings-page]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			const section = settings.locator("#setting-github-account");
			await section.scrollIntoViewIfNeeded();
			const card = section.getByTestId("github-sign-in");
			await expect(card).toHaveAttribute("data-github-phase", "signed-out", { timeout: 30_000 });
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

			// Sign out clears the account again.
			await shot("4-settings");
			await section.getByTestId("github-sign-out").click();
			await expect(card).toHaveAttribute("data-github-phase", "signed-out");
			expect(JSON.parse(await fs.readFile(ghState, "utf8")).active).toBeNull();
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
