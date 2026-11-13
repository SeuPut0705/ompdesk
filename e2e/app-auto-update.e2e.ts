/**
 * Settings › Updates & about › Install updates automatically (pref `appAutoUpdate`), end to end in relaunch
 * mode on a stand-in bundle: `OMP_DEV_UPDATE_MODE=relaunch` with `OMP_DEV_UPDATE_BUNDLE` (the bundle the
 * swap replaces) and `OMP_DEV_UPDATE_STAGED` (a verified update already staged, no release needed).
 * With the pref on (the default), main announces the restart (a quiet notice with a countdown, `restartAt` in the
 * status), then quits through the update path and the detached helper swaps the stand-in for the staged bundle,
 * all without a click. With the pref stored off the same staged update just waits for a click. The helper keeps
 * the old bundle until the new app writes its start mark (`<userData>/app-started.json`): a staged stand-in that
 * writes it for the expected version ends `started` with no `.previous`; one that exits without it ends with the
 * old stand-in back in place and reopened, `start failed; previous app restored`, no dialog. An Autopilot run
 * that runs across such an update continues after it: autopilot-restart.e2e.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { type StagedStart, stagedUpdateEnv } from "./fixture/stand-in-bundle";
import { exitApp, launchApp, pressShortcutUntilVisible } from "./harness";

test.skip(process.platform !== "darwin", "The relaunch install mode is macOS's");

const VERSION = "99.0.0";
/** Short enough for a test, long enough to see the notice (main's default is 60 s). */
const COUNTDOWN_MS = 4000;

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	ownBundle: string;
	swapLog: string;
	launchLog: string;
}

async function launch(
	name: string,
	prefs: Record<string, unknown>,
	env: Record<string, string> = {},
	start: StagedStart = {},
): Promise<Launched> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-app-update-${name}-`));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(agent), fs.mkdir(desktop)]);
	const update = await stagedUpdateEnv(root, desktop, VERSION, COUNTDOWN_MS, start);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, language: "en", ...prefs }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: { ...update.env, ...env },
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.updater != null);
	return { app, page, root, ownBundle: update.ownBundle, swapLog: update.swapLog, launchLog: update.launchLog };
}

async function close(launched: Launched): Promise<void> {
	// The pref-on test ends with the app gone through the update's own quit: Playwright has no process to ask any more.
	await exitApp(launched.app).catch(() => undefined);
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const status = (page: Page) => page.evaluate(() => window.omp.updater.getStatus());
const read = (file: string) => fs.readFile(file, "utf8").catch(() => "");
const exists = (file: string) =>
	fs.access(file).then(
		() => true,
		() => false,
	);
const lines = async (file: string) => (await read(file)).split("\n").filter(Boolean);

/** The automatic install's decision lines in `gui-runtime.jsonl` (source `app-update`, message `scheduler`), in order. */
async function schedulerEvents(launched: Launched): Promise<Array<{ event: string; reason?: string }>> {
	const log = await read(path.join(launched.root, "desktop", "logs", "gui-runtime.jsonl"));
	return log.split("\n").flatMap(line => {
		try {
			const entry = JSON.parse(line) as {
				source?: string;
				message?: string;
				details?: { event: string; reason?: string };
			};
			return entry.source === "app-update" && entry.message === "scheduler" && entry.details ? [entry.details] : [];
		} catch {
			return [];
		}
	});
}

test("with the pref on (the default), a staged update announces itself and installs without a click", async () => {
	test.setTimeout(90_000);
	const launched = await launch("on", {});
	try {
		const { page, app } = launched;
		const exited = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
		await expect.poll(async () => (await status(page)).state, { timeout: 15_000 }).toBe("downloaded");
		// The quiet notice first: a countdown the status carries, shown in the sidebar, never a dialog.
		await expect
			.poll(async () => ("restartAt" in (await status(page)) ? "announced" : "waiting"), { timeout: 15_000 })
			.toBe("announced");
		await expect(page.locator("[data-sidebar-update]")).toContainText(/restarting in \d+s/);
		expect(await read(launched.swapLog)).toBe("");
		// Then the quit through the update path, and the helper's swap: the stand-in now holds the staged bundle.
		await exited;
		await expect.poll(() => read(launched.swapLog), { timeout: 30_000 }).toContain("installed");
		expect(await read(path.join(launched.ownBundle, "Contents", "Resources", "marker"))).toBe("new");
		// The staged stand-in wrote the start mark for the expected version: the helper ends `started` and drops the old bundle.
		await expect
			.poll(() => read(launched.swapLog), { timeout: 30_000 })
			.toMatch(/installed\nwaiting for the new app to start\nstarted\n/);
		console.log(`swap.log (start seen):\n${await read(launched.swapLog)}`);
		expect(await exists(`${launched.ownBundle}.previous`)).toBe(false);
		expect(await lines(launched.launchLog)).toEqual(["new"]);
	} finally {
		await close(launched);
	}
});

test("a staged app that never marks its start is replaced by the previous one, reopened, with no dialog", async () => {
	test.setTimeout(120_000);
	// The staged stand-in exits without the start mark; the helper waits 6 s (default 120) before it takes the old one back.
	const launched = await launch("dies", {}, {}, { staged: "dies", startWaitSeconds: 6 });
	try {
		const { page, app } = launched;
		const exited = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
		await expect.poll(async () => (await status(page)).state, { timeout: 15_000 }).toBe("downloaded");
		await exited;
		await expect.poll(() => read(launched.swapLog), { timeout: 30_000 }).toContain("installed");
		await expect
			.poll(() => read(launched.swapLog), { timeout: 60_000 })
			.toMatch(/installed\nwaiting for the new app to start\nstart failed; previous app restored\n/);
		console.log(`swap.log (start failed):\n${await read(launched.swapLog)}`);
		// The old stand-in is back in place, whole, with nothing left beside it, and `open` started it again.
		expect(await read(path.join(launched.ownBundle, "Contents", "Resources", "marker"))).toBe("old");
		expect(await fs.readdir(path.dirname(launched.ownBundle))).toEqual(["Stand-in.app"]);
		await expect.poll(() => lines(launched.launchLog), { timeout: 30_000 }).toEqual(["new", "old"]);
		expect(await exists(path.join(launched.root, "desktop", "app-started.json"))).toBe(false);
	} finally {
		await close(launched);
	}
});

test("with the pref stored off the staged update waits for a click", async () => {
	test.setTimeout(90_000);
	const launched = await launch("off", { appAutoUpdate: false });
	try {
		const { page, app } = launched;
		await expect.poll(async () => (await status(page)).state, { timeout: 15_000 }).toBe("downloaded");
		// Well past the shortened countdown: nothing announced, nothing swapped, the app still runs.
		await page.waitForTimeout(COUNTDOWN_MS + 4000);
		expect(await status(page)).toEqual({ state: "downloaded", version: VERSION, mode: "relaunch" });
		expect(app.process().exitCode).toBeNull();
		expect(await read(launched.swapLog)).toBe("");
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="updates"]').click();
		await expect(settings.locator("#setting-gui-appAutoUpdate [role='switch']")).toHaveAttribute(
			"aria-checked",
			"false",
		);
		expect(await read(path.join(launched.ownBundle, "Contents", "Resources", "marker"))).toBe("old");
	} finally {
		await close(launched);
	}
});

test("with a turn's background subagent still working, the automatic install counts down and installs without waiting for it", async () => {
	test.setTimeout(120_000);
	// The switch starts off so the turn can start before the staged update is offered to the scheduler.
	const launched = await launch("background", { appAutoUpdate: false }, { OMP_GUI_TEST_BACKGROUND_JOB: "1" });
	try {
		const { page, app } = launched;
		await expect.poll(async () => (await status(page)).state, { timeout: 15_000 }).toBe("downloaded");
		const input = page.locator(".omp-composer-input").first();
		await input.fill("fixture background subagent");
		await input.press("Enter");
		// The turn ended; its subagent (a running `task` job) keeps the session unsettled, and stays so: never finished here.
		await expect(page.getByText("Watcher is on the release build in the background.")).toBeVisible({
			timeout: 30_000,
		});
		const exited = new Promise<void>(resolve => app.process().once("exit", () => resolve()));
		await page.evaluate(() => window.omp.prefs.set("appAutoUpdate", true));
		// Running background work does not hold the restart: the notice with its countdown, then the quit.
		await expect
			.poll(async () => ("restartAt" in (await status(page)) ? "announced" : "waiting"), { timeout: 20_000 })
			.toBe("announced");
		await exited;
		await expect.poll(() => read(launched.swapLog), { timeout: 30_000 }).toContain("installed");
		expect((await schedulerEvents(launched)).map(event => event.event)).toEqual(["safe", "countdown", "install"]);
	} finally {
		await close(launched);
	}
});
