/**
 * Automatic machine setup end to end with a fake installer
 * (`OMP_GUI_TEST_INSTALLER`: every plan runs `<installer> <item> <method>`).
 * omp is missing (`OMP_GUI_OMP` names a file that does not exist yet), so the
 * app starts installing it on its own: the setup screen shows the step running
 * with its command and output, the first attempt fails with a reason, manual
 * steps and Retry, and the retry puts the fake omp in place; main detects it,
 * restarts the tab and the session comes up ready — nobody pressed install.
 *
 * `OMP_GUI_SETUP_CAPTURES=<dir>` also captures the setup screens (running,
 * failed, Settings › General) in light/dark × en/ko plus a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

const CAPTURES = process.env.OMP_GUI_SETUP_CAPTURES ?? "";

/** The fake installer: logs each call; omp waits for the test's `go-<attempt>` file, fails attempt 1, installs on attempt 2. */
const INSTALLER = `
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [item, method] = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), item + " " + method + "\\n");
if (item !== "omp") {
	console.log("fake " + item + " install");
	process.exit(0);
}
const counter = join(dir, "omp-attempts");
const attempt = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(attempt));
console.log("\\u001b[32mResolving\\u001b[0m @oh-my-pi/pi-coding-agent (attempt " + attempt + ")");
while (!existsSync(join(dir, "go-" + attempt))) await Bun.sleep(25);
if (attempt === 1) {
	console.error("error: GET https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent - 503");
	process.exit(1);
}
renameSync(process.env.OMPDESK_FAKE_OMP + ".staged", process.env.OMPDESK_FAKE_OMP);
console.log("installed @oh-my-pi/pi-coding-agent with binaries:\\n - omp");
`;

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	errors: string[];
}

async function launch(name: string, prefs: Record<string, unknown>): Promise<Launched> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-setup-${name}-`));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const installerDir = path.join(root, "installer");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(installerDir)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ firstRunComplete: true, ...prefs }));
	// The fixture omp exists only once the fake installer moves it into place.
	const omp = await fixtureOmp(root);
	await fs.rename(omp, `${omp}.staged`);
	const installer = await writeFakeOmp(installerDir, INSTALLER);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: omp,
		OMP_GUI_TEST_INSTALLER: installer,
		OMPDESK_FAKE_INSTALLER_DIR: installerDir,
		OMPDESK_FAKE_OMP: omp,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, root, errors };
}

async function release(launched: Launched, attempt: number): Promise<void> {
	await fs.writeFile(path.join(launched.root, "installer", `go-${attempt}`), "");
}

async function installs(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "installer", "installs.log"), "utf8").catch(() => "");
	return log.split("\n").filter(Boolean);
}

async function capture(page: Page, name: string): Promise<void> {
	if (!CAPTURES) return;
	await fs.mkdir(CAPTURES, { recursive: true });
	await page.screenshot({ path: path.join(CAPTURES, `${name}.png`), scale: "css", animations: "disabled" });
}

async function close(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Missing omp → automatic install fails → retry → detected → the session starts. */
async function flow(launched: Launched, name: string, text: { retry: RegExp }): Promise<void> {
	const { page } = launched;
	const setup = page.getByTestId("machine-setup");
	await expect(setup).toBeVisible({ timeout: 30_000 });
	const omp = setup.locator('[data-setup-item="omp"]');
	// It started on its own: nobody pressed anything.
	await expect(omp).toHaveAttribute("data-phase", "running");
	await expect(setup.getByTestId("setup-cancel")).toBeVisible();
	await expect(setup).toContainText("install -g @oh-my-pi/pi-coding-agent");
	await expect(setup.getByRole("button", { name: /^install$/i })).toHaveCount(0);
	const toggle = setup.getByTestId("setup-output-toggle");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(setup).toContainText("Resolving @oh-my-pi/pi-coding-agent (attempt 1)");
	await setup.getByTestId("setup-cancel").scrollIntoViewIfNeeded();
	await capture(page, `${name}-1-running`);

	await release(launched, 1);
	await expect(omp).toHaveAttribute("data-phase", "failed");
	await expect(setup).toContainText("503");
	await expect(setup).toContainText("bun install -g @oh-my-pi/pi-coding-agent");
	const retry = setup.getByTestId("setup-retry");
	await expect(retry).toHaveText(text.retry);
	await retry.scrollIntoViewIfNeeded();
	await capture(page, `${name}-2-failed`);

	await retry.click();
	await expect(omp).toHaveAttribute("data-phase", "running");
	await release(launched, 2);
	// Detected, then main restarts the tab on its own.
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 30_000 })
		.toBe("ready");
	await expect(setup).toHaveCount(0);
	expect((await installs(launched)).filter(line => line.startsWith("omp "))).toEqual([
		"omp bun-global",
		"omp bun-global",
	]);
	const state = await page.evaluate(() => window.omp.setup.getState());
	expect(state.ompReady).toBe(true);
	expect(state.items.find(item => item.id === "omp")?.phase).toBe("present");
}

test("missing omp installs on its own; a failed attempt shows why and retries into a ready session", async () => {
	test.setTimeout(120_000);
	const launched = await launch("flow", { language: "en" });
	try {
		await flow(launched, "en-light", { retry: /Retry|Try again/ });
		await expect(launched.page.getByText("What should we build?")).toBeVisible();
		expect(launched.errors).toEqual([]);
	} finally {
		await close(launched);
	}
});

for (const [language, theme] of [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const) {
	test(`setup captures (${language} ${theme})`, async () => {
		test.skip(!CAPTURES, "OMP_GUI_SETUP_CAPTURES=<dir> captures the setup screens");
		test.setTimeout(120_000);
		const launched = await launch(`${language}-${theme}`, { language, themeName: theme });
		try {
			await flow(launched, `${language}-${theme}`, { retry: /.+/ });
			const settings = launched.page.locator("[data-settings-page]");
			await pressShortcutUntilVisible(launched.page, "ControlOrMeta+Comma", settings);
			const section = launched.page.getByTestId("machine-setup-settings");
			await section.scrollIntoViewIfNeeded();
			await expect(section).toBeVisible();
			await capture(launched.page, `${language}-${theme}-3-settings`);
		} finally {
			await close(launched);
		}
	});
}

test("setup capture (narrow window)", async () => {
	test.skip(!CAPTURES, "OMP_GUI_SETUP_CAPTURES=<dir> captures the setup screens");
	test.setTimeout(120_000);
	const launched = await launch("narrow", { language: "ko" });
	try {
		await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(560, 820));
		await flow(launched, "narrow-ko", { retry: /.+/ });
	} finally {
		await close(launched);
	}
});
