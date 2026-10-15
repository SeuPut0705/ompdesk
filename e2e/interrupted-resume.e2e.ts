/**
 * Turns that continue on their own, on the fake omp.
 *
 * Relaunch: a turn running when OMPdesk dies (SIGKILL, no hook runs) or quits
 * normally continues on the next launch with the same userData, announced by a
 * "Continuing N interrupted tasks" toast; a turn the user stopped does not. The
 * marker file is written on run-state transitions, so a crash leaves it behind.
 *
 * Offline: a network error while the window is offline shows a calm waiting row
 * with Cancel instead of the failure card, and stock `retry` runs once an
 * `online` event arrives. Captures: light/dark × en/ko.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: {
		waiting: "Waiting for the internet connection…",
		continuing: "Continuing 1 interrupted task",
		cancel: "Cancel",
	},
	ko: {
		waiting: "인터넷 연결을 기다리는 중이에요…",
		continuing: "중단된 작업 1개를 이어서 하고 있어요",
		cancel: "취소",
	},
} as const;

interface Profile {
	root: string;
	desktop: string;
	env: Record<string, string>;
}

async function makeProfile(language: Language, theme: Theme): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-resume-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true, lastProject: project }),
	);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, desktop, env };
}

/**
 * Launch on the profile's userData with no argv cwd, so a relaunch restores the saved layout.
 * `ready: false` returns once the window exists: a relaunch's toast and resumed turn can be over
 * by the time the sidecar reports ready on a loaded machine.
 */
async function launch(
	profile: Profile,
	options: { ready?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	if (options.ready === false) return { app, page };
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page };
}

async function capture(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled", scale: "css" });
}

interface MarkerFile {
	reason: string;
	sessionPath: string;
}

async function markers(profile: Profile): Promise<MarkerFile[]> {
	try {
		return JSON.parse(
			await fs.readFile(path.join(profile.desktop, "interrupted-turns.json"), "utf8"),
		) as MarkerFile[];
	} catch {
		return [];
	}
}

/** The saved layout names the tab's session file: what a relaunch reopens. */
async function layoutHasSession(profile: Profile): Promise<boolean> {
	try {
		const prefs = JSON.parse(await fs.readFile(path.join(profile.desktop, "prefs.json"), "utf8")) as {
			tabLayouts?: Array<{ tabs: Array<{ sessionPath?: string }> }>;
		};
		return prefs.tabLayouts?.some(layout => layout.tabs.some(tab => tab.sessionPath !== undefined)) === true;
	} catch {
		return false;
	}
}

async function startLongTurn(profile: Profile, page: Page): Promise<void> {
	const input = page.locator(".omp-composer-input").first();
	await input.fill("fixture running");
	await input.press("Enter");
	await expect.poll(() => markers(profile), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
	await expect.poll(() => layoutHasSession(profile), { timeout: 30_000 }).toBe(true);
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * SIGKILL of the app's main process: no quit hook, no teardown, no graceful anything. The pid comes from
 * the app itself: on Windows `app.process()` is a launcher one level above it, and killing that leaves the
 * app running.
 */
async function crash(app: ElectronApplication): Promise<void> {
	const pid = await app.evaluate(() => process.pid);
	process.kill(pid, "SIGKILL");
	await expect.poll(() => isRunning(pid), { timeout: 20_000, message: "the killed app must be gone" }).toBe(false);
}

/**
 * Processes whose command line names the profile: what the killed app left running. Children get an
 * open stdin pipe and end when it closes (AGENTS.md), because a SIGKILL runs no quit handler.
 */
function survivors(root: string): string[] {
	if (process.platform === "win32") {
		const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${root.replaceAll("'", "''")}') } | ForEach-Object { "$($_.ProcessId) ppid=$($_.ParentProcessId) threads=$($_.ThreadCount) $($_.Name) $($_.CommandLine)" }`;
		return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" })
			.split(/\r?\n/)
			.filter(Boolean);
	}
	return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
		.split("\n")
		.filter(line => line.includes(root));
}

async function cleanup(profile: Profile): Promise<void> {
	// Windows refuses to remove a folder some process still has as its cwd: let the app's children end first.
	await expect
		.poll(() => survivors(profile.root), { timeout: 20_000 })
		.toEqual([])
		.catch(() => undefined);
	await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`${language === "en" && theme === "light" ? "@smoke " : ""}a turn running when OMPdesk is killed continues on the next launch (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const profile = await makeProfile(language, theme);
			const text = TEXT[language];
			let current: ElectronApplication | undefined;
			try {
				const first = await launch(profile);
				current = first.app;
				await startLongTurn(profile, first.page);
				// The marker is already on disk and no quit hook will run.
				await crash(first.app);
				await expect
					.poll(() => survivors(profile.root), { timeout: 20_000, message: "the killed app's children must end" })
					.toEqual([]);

				const second = await launch(profile, { ready: false });
				current = second.app;
				await expect(second.page.getByText(text.continuing)).toBeVisible({ timeout: 30_000 });
				await capture(second.page, `${language}-${theme}-relaunch-toast`);
				await expect(second.page.getByText("Continued after the interruption.")).toBeVisible({ timeout: 30_000 });
				// The finished turn leaves no marker behind.
				await expect.poll(() => markers(profile), { timeout: 15_000 }).toEqual([]);
				await capture(second.page, `${language}-${theme}-relaunch-resumed`);
			} finally {
				if (current) await exitApp(current);
				await cleanup(profile);
			}
		});

test("@smoke a normal quit continues the running turn on the next launch, and the quit prompt says so", async () => {
	test.setTimeout(150_000);
	const profile = await makeProfile("en", "light");
	let current: ElectronApplication | undefined;
	try {
		const first = await launch(profile);
		current = first.app;
		await startLongTurn(profile, first.page);

		// Answer the "sessions are still running" prompt with "Quit anyway" and keep what it said.
		await first.app.evaluate(({ app, dialog }) => {
			const record = globalThis as { quitPrompt?: string };
			dialog.showMessageBox = (async (...args: unknown[]) => {
				const options = args.at(-1) as { detail?: string };
				record.quitPrompt = options.detail;
				return { response: 0, checkboxChecked: false };
			}) as never;
			setImmediate(() => app.quit());
		});
		const child = first.app.process();
		await new Promise<void>(resolve => {
			if (child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once("exit", () => resolve());
		});
		current = undefined;
		// Quitting must not have cleared what the turn was doing.
		expect(await markers(profile)).toMatchObject([{ reason: "running" }]);

		const second = await launch(profile, { ready: false });
		current = second.app;
		await expect(second.page.getByText(TEXT.en.continuing)).toBeVisible({ timeout: 30_000 });
		await expect(second.page.getByText("Continued after the interruption.")).toBeVisible({ timeout: 30_000 });
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});

test("a turn the user stopped is not resumed after a crash", async () => {
	test.setTimeout(150_000);
	const profile = await makeProfile("en", "light");
	let current: ElectronApplication | undefined;
	try {
		const first = await launch(profile);
		current = first.app;
		await startLongTurn(profile, first.page);
		await first.page.getByRole("button", { name: "Stop", exact: true }).first().click();
		await expect.poll(() => markers(profile), { timeout: 15_000 }).toEqual([]);
		await crash(first.app);

		const second = await launch(profile);
		current = second.app;
		await expect(second.page.getByText("fixture running").first()).toBeVisible({ timeout: 30_000 });
		await expect(second.page.getByText(TEXT.en.continuing)).toHaveCount(0);
		await expect(second.page.getByText("Continued after the interruption.")).toHaveCount(0);
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});

test("the setting off: a killed turn is not resumed and leaves no marker", async () => {
	test.setTimeout(150_000);
	const profile = await makeProfile("en", "light");
	let current: ElectronApplication | undefined;
	try {
		const first = await launch(profile);
		current = first.app;
		await first.page.evaluate(() => window.omp.prefs.set("resumeInterrupted", false));
		const input = first.page.locator(".omp-composer-input").first();
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(first.page.getByRole("button", { name: "Stop", exact: true }).first()).toBeVisible({
			timeout: 30_000,
		});
		expect(await markers(profile)).toEqual([]);
		await crash(first.app);

		const second = await launch(profile);
		current = second.app;
		await expect(second.page.getByText("fixture running").first()).toBeVisible({ timeout: 30_000 });
		await expect(second.page.getByText("Continued after the interruption.")).toHaveCount(0);
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`a network error while offline waits calmly and continues when the connection returns (${language} ${theme})`, async () => {
			test.setTimeout(120_000);
			const profile = await makeProfile(language, theme);
			const text = TEXT[language];
			let current: ElectronApplication | undefined;
			try {
				const { app, page } = await launch(profile);
				current = app;
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				await page.evaluate(() => window.dispatchEvent(new Event("offline")));
				const input = page.locator(".omp-composer-input").first();
				await input.fill("fixture network error");
				await input.press("Enter");

				const wait = page.locator("[data-connection-wait]");
				await expect(wait).toBeVisible({ timeout: 30_000 });
				await expect(wait).toContainText(text.waiting);
				await expect(page.locator(".omp-message-error")).toHaveCount(0);
				await capture(page, `${language}-${theme}-waiting`);

				// The connection returns: stock retry runs the turn again with no click.
				await page.evaluate(() => window.dispatchEvent(new Event("online")));
				await expect(page.getByText("Back online: the turn went on.")).toBeVisible({ timeout: 30_000 });
				await expect(wait).toHaveCount(0);
				await capture(page, `${language}-${theme}-continued`);
				expect(errors).toEqual([]);
			} finally {
				if (current) await exitApp(current);
				await cleanup(profile);
			}
		});

test("Cancel on the waiting row shows the failure and nothing resumes when the connection returns", async () => {
	test.setTimeout(120_000);
	const profile = await makeProfile("en", "light");
	let current: ElectronApplication | undefined;
	try {
		const { app, page } = await launch(profile);
		current = app;
		await page.evaluate(() => window.dispatchEvent(new Event("offline")));
		const input = page.locator(".omp-composer-input").first();
		await input.fill("fixture network error");
		await input.press("Enter");
		const wait = page.locator("[data-connection-wait]");
		await expect(wait).toBeVisible({ timeout: 30_000 });

		await wait.getByRole("button", { name: TEXT.en.cancel }).click();
		await expect(wait).toHaveCount(0);
		await expect(page.locator(".omp-message-error")).toBeVisible();

		await page.evaluate(() => window.dispatchEvent(new Event("online")));
		await expect(page.getByText("Back online: the turn went on.")).toHaveCount(0);
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});
