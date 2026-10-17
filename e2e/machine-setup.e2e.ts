/**
 * Automatic machine setup end to end with a fake installer
 * (`OMP_GUI_TEST_INSTALLER`: every plan runs `<installer> <item> <method>`).
 * omp is missing (`OMP_GUI_OMP` names a file that does not exist yet), so the
 * app starts installing it on its own: main first downloads a file from a
 * local server (`OMP_GUI_TEST_DOWNLOAD`), which holds the first request at
 * half its bytes so the screen shows 50 % with the step and its clock; then
 * the step runs with its command and output, the first attempt fails with a
 * reason, manual steps and Retry, and the retry puts the fake omp in place;
 * main detects it, restarts the tab and the session comes up ready — nobody
 * pressed install. While the setup screen shows it owns the whole window: the
 * sidebar and Settings clicks, global shortcuts and the palette do nothing, and
 * Tab never leaves the dialog.
 *
 * `OMP_GUI_SETUP_CAPTURES=<dir>` also captures the setup screens (download,
 * running, failed, Settings › Updates & about) in light/dark × en/ko plus a narrow window.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
	console.error(process.env.OMPDESK_FAKE_FAIL_OUTPUT || "error: GET https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent - 503");
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
	server: Server;
	/** Lets the held first download finish. */
	finishDownload: () => void;
}

const DOWNLOAD = new Uint8Array(4 * 1_048_576).map((_, index) => index % 251);

/** Serves DOWNLOAD with its size; the first request stops at half until `finish`. */
async function downloadServer(): Promise<{ server: Server; url: string; finish: () => void }> {
	const held = Promise.withResolvers<void>();
	let requests = 0;
	const server = createServer((_request, response) => {
		requests += 1;
		const first = requests === 1;
		response.writeHead(200, { "content-length": String(DOWNLOAD.byteLength) });
		const half = DOWNLOAD.byteLength / 2;
		response.write(DOWNLOAD.subarray(0, half));
		void (first ? held.promise : Promise.resolve()).then(() => response.end(DOWNLOAD.subarray(half)));
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return { server, url: `http://127.0.0.1:${port}/omp.bin`, finish: () => held.resolve() };
}

interface LaunchOptions {
	/** A profile an earlier launch left behind (quit mid-install): same user data, same staged omp. */
	reuse?: string;
	/** What the fake installer's failing attempt prints. */
	failOutput?: string;
	/** omp is installed but older than the minimum (the install runs `omp update`). */
	outdated?: boolean;
}

async function launch(name: string, prefs: Record<string, unknown>, options: LaunchOptions = {}): Promise<Launched> {
	const root = options.reuse ?? (await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-setup-${name}-`)));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const installerDir = path.join(root, "installer");
	let omp: string;
	if (options.reuse) omp = await fs.readFile(path.join(root, "omp-path"), "utf8");
	else {
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(installerDir)]);
		await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ firstRunComplete: true, ...prefs }));
		// The fixture omp exists only once the fake installer moves it into place.
		omp = await fixtureOmp(root);
		await fs.rename(omp, `${omp}.staged`);
		await fs.writeFile(path.join(root, "omp-path"), omp);
		if (options.outdated) {
			// An omp that is there but below the minimum: the fake installer's second attempt replaces it with the real fixture.
			await writeFakeOmp(
				root,
				'if (process.argv.includes("--version")) console.log("18.0.0");\nelse process.exit(1);\n',
			);
		}
	}
	const installer = await writeFakeOmp(installerDir, INSTALLER);
	const download = await downloadServer();
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: omp,
		OMP_GUI_TEST_INSTALLER: installer,
		OMP_GUI_TEST_DOWNLOAD: download.url,
		OMP_GUI_TEST_DOWNLOAD_SHA256: createHash("sha256").update(DOWNLOAD).digest("hex"),
		OMPDESK_FAKE_INSTALLER_DIR: installerDir,
		OMPDESK_FAKE_OMP: omp,
		...(options.failOutput ? { OMPDESK_FAKE_FAIL_OUTPUT: options.failOutput } : {}),
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
	return { app, page, root, errors, server: download.server, finishDownload: download.finish };
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
	launched.finishDownload();
	launched.server.close();
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * The setup screen owns the window: one modal dialog, the app behind it is
 * inert (clicks and shortcuts do nothing), and Tab never leaves it.
 */
async function expectTakeover(page: Page): Promise<void> {
	const takeover = page.getByTestId("setup-takeover");
	await expect(takeover).toHaveAttribute("role", "dialog");
	await expect(takeover).toHaveAttribute("aria-modal", "true");
	await expect(takeover).toHaveAccessibleName(/.+/);
	await expect(takeover.locator("h1")).toBeVisible();
	const box = await takeover.boundingBox();
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	expect(box).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
	// The sidebar and the titlebar sit under the screen, inert.
	const covered = page.locator("[data-sidebar-destinations]");
	expect(await covered.evaluate(element => element.closest("[inert]") !== null)).toBe(true);

	// Clicks reach the screen, not the sidebar: forced clicks land on whatever is on top.
	const settingsRow = covered.locator('[data-destination="settings"]');
	await settingsRow.click({ force: true });
	await page.locator("[data-command-center-entry]").first().click({ force: true });
	// Shortcuts: settings, command palette, new tab, quick open.
	for (const chord of ["ControlOrMeta+Comma", "ControlOrMeta+K", "ControlOrMeta+T", "ControlOrMeta+P"]) {
		await page.keyboard.press(chord);
	}
	// Two frames: any handler that would have opened something has run by now.
	await page.evaluate(() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		return promise;
	});
	await expect(settingsRow).not.toHaveAttribute("aria-current", "page");
	await expect(page.locator("[data-settings-page]")).toHaveCount(0);
	await expect(page.getByRole("dialog")).toHaveCount(1);
	await expect(takeover).toBeVisible();

	// Focus is trapped: forward and backward, it never leaves the screen.
	const insideTakeover = () =>
		page.evaluate(
			() => document.querySelector('[data-testid="setup-takeover"]')?.contains(document.activeElement) === true,
		);
	expect(await insideTakeover()).toBe(true);
	for (const key of [...Array(6).fill("Tab"), ...Array(6).fill("Shift+Tab")]) {
		await page.keyboard.press(key);
		expect(await insideTakeover()).toBe(true);
	}
}

async function flow(launched: Launched, name: string, text: { retry: RegExp }): Promise<void> {
	const { page } = launched;
	const setup = page.getByTestId("machine-setup");
	await expect(setup).toBeVisible({ timeout: 30_000 });
	const omp = setup.locator('[data-setup-item="omp"]');
	// It started on its own: nobody pressed anything. Main downloads first, with real byte progress.
	await expect(omp).toHaveAttribute("data-phase", "running");
	const bar = omp.getByRole("progressbar");
	await expect(bar).toHaveAttribute("aria-valuenow", "0.5");
	await expect(omp).toContainText("50%");
	// One step in this run: no "Step 1 of 1".
	await expect(omp).not.toContainText(/Step \d of \d|\d단계 중 \d단계/);
	await expect(page.getByTestId("setup-takeover").locator("h1")).toHaveText(
		/Installing omp on this computer|이 컴퓨터에 omp를 설치하고 있어요/,
	);
	await expect(omp).toContainText(/2\.0 MB/);
	await expect(setup.getByTestId("setup-cancel")).toBeVisible();
	await expectTakeover(page);
	await capture(page, `${name}-0-download`);
	launched.finishDownload();
	// The installer's own work has no percent: the bar slides.
	await expect(bar).not.toHaveAttribute("aria-valuenow", /./);
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
	// A failed install no longer promises "nothing for you to do": the heading names what is missing.
	await expect(page.getByTestId("setup-takeover").locator("h1")).toHaveText(
		/omp isn't installed yet|omp 설치가 아직 끝나지 않았어요/,
	);
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

test("@smoke missing omp installs on its own; a failed attempt shows why and retries into a ready session", async () => {
	test.setTimeout(120_000);
	// An update (older last-seen version): the What's new card must wait out the setup takeover.
	const launched = await launch("flow", { language: "en", whatsNewSeenVersion: "0.0.1" });
	try {
		const { page } = launched;
		await expect(page.getByTestId("setup-takeover")).toBeVisible({ timeout: 30_000 });
		await expect(page.locator("[data-whats-new-card]")).toHaveCount(0);
		expect(await page.evaluate(() => window.omp.prefs.get("whatsNewSeenVersion"))).toBe("0.0.1");
		await flow(launched, "en-light", { retry: /Retry|Try again/ });
		await expect(page.getByText("What should we build?")).toBeVisible();
		// Setup is over: now the card (not a modal) offers the notes, and the version counts as seen.
		const version = await page.evaluate(() => window.omp.updater.version());
		await expect(page.locator("[data-whats-new-card]")).toBeVisible({ timeout: 30_000 });
		await expect(page.locator("[data-whats-new-card]")).toContainText(version);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.omp.prefs.get("whatsNewSeenVersion"))).toBe(version);
		// Esc with focus in the card dismisses it, and no dialog opens.
		await page.locator("[data-whats-new-card]").focus();
		await page.keyboard.press("Escape");
		await expect(page.locator("[data-whats-new-card]")).toHaveCount(0);
		await expect(page.getByRole("dialog")).toHaveCount(0);
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
			await settings.locator('[data-settings-section="updates"]').click();
			const section = settings.locator("#setting-machine-setup");
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

/** Quit the way a user does (⌘Q runs the quit handlers; `exitApp` would skip them like a kill) and release the fakes. */
async function quit(launched: Launched): Promise<void> {
	const exited = Promise.withResolvers<void>();
	launched.app.process().once("exit", () => exited.resolve());
	void launched.app
		.evaluate(({ app }) => {
			setImmediate(() => app.quit());
		})
		.catch(() => undefined);
	await exited.promise;
	launched.finishDownload();
	launched.server.close();
}

test("quitting mid-install any number of times never pauses the next launch", async () => {
	test.setTimeout(180_000);
	const first = await launch("quit", { language: "en" });
	let launched = first;
	try {
		// Four launches, each quit while the download runs: three would reach the back-off if a quit counted as a miss.
		for (let round = 0; round < 4; round++) {
			if (round > 0) launched = await launch("quit", { language: "en" }, { reuse: first.root });
			const omp = launched.page.getByTestId("machine-setup").locator('[data-setup-item="omp"]');
			await expect(omp).toHaveAttribute("data-phase", "running", { timeout: 30_000 });
			await expect(omp).toContainText("50%");
			if (round < 3) await quit(launched);
		}
		await expect(launched.page.getByTestId("setup-takeover").locator("h1")).toHaveText(
			"Installing omp on this computer",
		);
		expect(launched.errors).toEqual([]);
	} finally {
		await close(launched);
	}
});
