/**
 * Turns that continue on their own, on the fake omp.
 *
 * Relaunch: a turn running when OMPdesk dies (SIGKILL, no hook runs) or quits
 * normally continues on the next launch with the same userData, quietly: no toast, one calm "Continuing" row per
 * resuming tab (with Stop), the background job the restart stopped named to the agent in a muted transcript line
 * (never a user bubble), the transcript left at the bottom of the live turn; a turn the user stopped does not
 * continue. The marker file is written on run-state transitions, so a crash leaves it behind.
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
import { capture, exitApp, fixtureOmp, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: {
		waiting: "Waiting for the internet connection…",
		notice: "Re-running 1 background task(s) the restart stopped",
		cancel: "Cancel",
	},
	ko: {
		waiting: "인터넷 연결을 기다리는 중이에요…",
		notice: "재시작 때 멈춘 백그라운드 작업 1개를 다시 실행해요",
		cancel: "취소",
	},
} as const;

declare global {
	/** Main process, the setting-off quit test: the quit dialogs shown, and the answer to the one held open. */
	var quitDialogs: Array<{ message: unknown; buttons: unknown }> | undefined;
	var answerQuit: (() => void) | undefined;
}

interface Profile {
	root: string;
	desktop: string;
	agent: string;
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
	return { root, desktop, agent, env };
}

/**
 * Launch on the profile's userData with no argv cwd, so a relaunch restores the saved layout.
 * `ready: false` returns once the window exists: a relaunch's toast and resumed turn can be over
 * by the time the sidecar reports ready on a loaded machine.
 */
async function launch(
	profile: Profile,
	options: { ready?: boolean; height?: number } = {},
): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	await app.evaluate(
		({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, height),
		options.height ?? 860,
	);
	await page.waitForFunction(() => window.omp?.rpc != null);
	if (options.ready === false) return { app, page };
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page };
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

/** Sends a turn that runs until stopped; resolves with its session file once the marker and the layout name it. */
async function startLongTurn(profile: Profile, page: Page): Promise<string> {
	const input = page.locator(".omp-composer-input").first();
	await input.fill("fixture running with job");
	await input.press("Enter");
	await expect.poll(() => markers(profile), { timeout: 30_000 }).toMatchObject([{ reason: "running" }]);
	await expect.poll(() => layoutHasSession(profile), { timeout: 30_000 }).toBe(true);
	return (await markers(profile))[0]?.sessionPath ?? "";
}

/** Every session file of the profile's agent dir. */
async function sessionFiles(profile: Profile): Promise<string[]> {
	const root = path.join(profile.agent, "sessions");
	const names = await fs.readdir(root, { recursive: true }).catch(() => []);
	return names.filter(name => name.endsWith(".jsonl")).map(name => path.join(root, name));
}

/**
 * The continued turn answered in the session it was cut off in: that file holds the answer, no second session
 * file holds the prompt again, and the sidebar lists the conversation once, as the indexed session of its tab.
 */
async function expectOneSession(profile: Profile, page: Page, sessionPath: string): Promise<void> {
	await expect
		.poll(() => fs.readFile(sessionPath, "utf8").catch(() => ""), { timeout: 15_000 })
		.toContain("Continued after the interruption.");
	expect(await sessionFiles(profile)).toEqual([sessionPath]);
	const rows = page.locator(".omp-session-sidebar .omp-sidebar-session-row[data-session-path]");
	await expect
		.poll(
			() =>
				rows.evaluateAll(elements =>
					elements.map(row => ({
						path: row.getAttribute("data-session-path"),
						live: row.hasAttribute("data-live"),
					})),
				),
			{ timeout: 15_000 },
		)
		.toEqual([{ path: sessionPath, live: false }]);
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

/** What a relaunch's window shows while the turn continues, recorded from the first frame on. */
interface ResumeProbe {
	/** The most `[data-resuming]` rows seen at once, and whether any was ever shown. */
	rows: number;
	/** Toasts that said anything about the interruption. */
	toasts: string[];
}

declare global {
	interface Window {
		__resumeProbe?: ResumeProbe;
	}
}

async function probeResume(page: Page): Promise<void> {
	await page.evaluate(() => {
		const probe: ResumeProbe = { rows: 0, toasts: [] };
		window.__resumeProbe = probe;
		const scan = () => {
			probe.rows = Math.max(probe.rows, document.querySelectorAll("[data-resuming]").length);
			for (const toast of document.querySelectorAll("[data-toast-stack] > *")) {
				const text = toast.textContent ?? "";
				if (/interrupted task|중단된 작업/.test(text) && !probe.toasts.includes(text)) probe.toasts.push(text);
			}
		};
		scan();
		new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
	});
}

/** Distance from the transcript's end to the bottom of what is scrolled to (0 = pinned to the live turn). */
async function gapToBottom(page: Page): Promise<{ gap: number; overflow: number }> {
	return page.locator(".omp-transcript-scroll").evaluate(node => ({
		gap: node.scrollHeight - node.scrollTop - node.clientHeight,
		overflow: node.scrollHeight - node.clientHeight,
	}));
}

/**
 * The continuation is quiet and natural: one resuming row at most at a time and no toast; the restart's
 * background-job notice is one muted line (not a user bubble: the only user bubble is the prompt itself, and the
 * notice's text never reaches the screen); and the transcript ends at the bottom with the answer.
 */
async function expectQuietContinuation(page: Page, notice: string): Promise<void> {
	await expect(page.getByText("Continued after the interruption.")).toBeVisible({ timeout: 30_000 });
	await expect(page.locator("[data-restart-jobs]")).toHaveText(notice);
	await expect(page.locator("[data-restart-jobs]")).toHaveCount(1);
	// The prompt's own bubble is the only one (it carries its clock after the text).
	await expect(page.locator(".omp-user-bubble")).toHaveText([/^fixture running with job/]);
	await expect(page.getByText("OMPdesk restarted")).toHaveCount(0);
	await expect(page.locator("[data-resuming]")).toHaveCount(0);
	const probe = await page.evaluate(() => window.__resumeProbe);
	expect(probe?.rows, "the resuming row was shown").toBe(1);
	expect(probe?.toasts, "no toast announces the resume").toEqual([]);
	// The window is short on purpose: the transcript overflows, so "at the bottom" is a real claim.
	expect((await gapToBottom(page)).overflow, "the transcript overflows the short window").toBeGreaterThan(0);
	await expect
		.poll(async () => (await gapToBottom(page)).gap, { message: "the transcript stays at the bottom" })
		.toBeLessThanOrEqual(2);
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`${language === "en" && theme === "light" ? "@smoke " : ""}a turn running when OMPdesk is killed continues on the next launch (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const profile = await makeProfile(language, theme);
			const text = TEXT[language];
			let current: ElectronApplication | undefined;
			try {
				const first = await launch(profile);
				current = first.app;
				const sessionPath = await startLongTurn(profile, first.page);
				// The marker is already on disk and no quit hook will run.
				await crash(first.app);
				await expect
					.poll(() => survivors(profile.root), { timeout: 20_000, message: "the killed app's children must end" })
					.toEqual([]);

				const second = await launch(profile, { ready: false, height: 420 });
				current = second.app;
				await probeResume(second.page);
				await expect(second.page.locator("[data-resuming]")).toHaveCount(1, { timeout: 30_000 });
				await capture(second.page, `${language}-${theme}-relaunch-resuming`);
				await expectQuietContinuation(second.page, text.notice);
				// The finished turn leaves no marker behind.
				await expect.poll(() => markers(profile), { timeout: 15_000 }).toEqual([]);
				await expectOneSession(profile, second.page, sessionPath);
				await capture(second.page, `${language}-${theme}-relaunch-resumed`);
			} finally {
				if (current) await exitApp(current);
				await cleanup(profile);
			}
		});

test("@smoke a normal quit asks nothing and continues the running turn on the next launch", async () => {
	test.setTimeout(150_000);
	const profile = await makeProfile("en", "light");
	let current: ElectronApplication | undefined;
	try {
		const first = await launch(profile);
		current = first.app;
		const sessionPath = await startLongTurn(profile, first.page);

		// Continue interrupted work is on: the quit asks nothing. A prompt would be answered "Keep working",
		// so the app would not exit and the wait below would time out.
		await first.app.evaluate(({ app, dialog }) => {
			dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as never;
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

		const second = await launch(profile, { ready: false, height: 420 });
		current = second.app;
		await probeResume(second.page);
		await expectQuietContinuation(second.page, TEXT.en.notice);
		await expectOneSession(profile, second.page, sessionPath);
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
		await expect(second.page.locator("[data-resuming]")).toHaveCount(0);
		await expect(second.page.getByText("Continued after the interruption.")).toHaveCount(0);
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});

test("the setting off: a quit asks before stopping the running turn, and quitting anyway leaves nothing to continue", async () => {
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
		await expect.poll(() => layoutHasSession(profile), { timeout: 30_000 }).toBe(true);
		// The quit asks only while a turn runs (`quitRisk` counts the tabs whose run is in flight).
		await expect
			.poll(async () => (await first.page.evaluate(() => window.omp.tabs.list())).map(tab => tab.status))
			.toEqual(["running"]);

		// The quit's dialog is recorded and held open until the test answers it "Quit anyway" (0).
		await first.app.evaluate(({ app, dialog }) => {
			globalThis.quitDialogs = [];
			dialog.showMessageBox = (async (...args: unknown[]) => {
				const options = args.at(-1);
				if (options && typeof options === "object" && "message" in options && "buttons" in options)
					globalThis.quitDialogs?.push({ message: options.message, buttons: options.buttons });
				await new Promise<void>(resolve => {
					globalThis.answerQuit = resolve;
				});
				return { response: 0, checkboxChecked: false };
			}) as never;
			setImmediate(() => app.quit());
		});
		await expect
			.poll(() => first.app.evaluate(() => globalThis.quitDialogs), { timeout: 15_000 })
			.toEqual([{ message: "Sessions are still running", buttons: ["Quit anyway", "Keep working"] }]);
		const child = first.app.process();
		const exited = new Promise<void>(resolve => {
			if (child.exitCode !== null || child.signalCode !== null) resolve();
			else child.once("exit", () => resolve());
		});
		// Answered on the next tick, so this evaluate returns before the app quits under it.
		await first.app.evaluate(() => {
			setImmediate(() => globalThis.answerQuit?.());
		});
		await exited;
		current = undefined;
		expect(await markers(profile)).toEqual([]);

		const second = await launch(profile);
		current = second.app;
		await expect(second.page.getByText("fixture running").first()).toBeVisible({ timeout: 30_000 });
		await expect(second.page.locator("[data-resuming]")).toHaveCount(0);
		await expect(second.page.getByText("Continued after the interruption.")).toHaveCount(0);
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
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
