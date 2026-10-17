/**
 * Settings › Updates & about › Install updates automatically (pref `appAutoUpdate`), end to end in relaunch
 * mode on a stand-in bundle: `OMP_DEV_UPDATE_MODE=relaunch` with `OMP_DEV_UPDATE_BUNDLE` (the bundle the
 * swap replaces) and `OMP_DEV_UPDATE_STAGED` (a verified update already staged, no release needed).
 * With the pref on, main announces the restart (a quiet notice with a countdown, `restartAt` in the status),
 * then quits through the update path and the detached helper swaps the stand-in for the staged bundle,
 * all without a click. With the pref off (the default) the same staged update just waits for a click.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
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
}

/** A minimal bundle `open` can start: an Info.plist and an executable. `marker` tells the two apart. */
async function writeBundle(bundle: string, marker: string): Promise<void> {
	await fs.mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
	await fs.mkdir(path.join(bundle, "Contents", "Resources"), { recursive: true });
	await fs.writeFile(
		path.join(bundle, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>stand-in</string>
<key>CFBundleIdentifier</key><string>com.seuput.ompdesk.e2e-stand-in</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
	);
	await fs.writeFile(path.join(bundle, "Contents", "MacOS", "stand-in"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	await fs.writeFile(path.join(bundle, "Contents", "Resources", "marker"), marker);
}

async function launch(name: string, prefs: Record<string, unknown>): Promise<Launched> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-app-update-${name}-`));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	const ownBundle = path.join(root, "apps", "Stand-in.app");
	const staged = path.join(desktop, "updates", VERSION, "Stand-in.app");
	await Promise.all([
		fs.mkdir(project),
		fs.mkdir(agent),
		fs.mkdir(path.join(desktop, "updates", VERSION), { recursive: true }),
	]);
	await writeBundle(ownBundle, "old");
	await writeBundle(staged, "new");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, language: "en", ...prefs }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			OMP_DEV_UPDATE_MODE: "relaunch",
			OMP_DEV_UPDATE_BUNDLE: ownBundle,
			OMP_DEV_UPDATE_STAGED: staged,
			OMP_DEV_UPDATE_STAGED_VERSION: VERSION,
			OMP_DEV_UPDATE_AUTO_COUNTDOWN_MS: String(COUNTDOWN_MS),
		},
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.updater != null);
	return { app, page, root, ownBundle, swapLog: path.join(desktop, "updates", "swap.log") };
}

async function close(launched: Launched): Promise<void> {
	// The pref-on test ends with the app gone through the update's own quit: Playwright has no process to ask any more.
	await exitApp(launched.app).catch(() => undefined);
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const status = (page: Page) => page.evaluate(() => window.omp.updater.getStatus());
const read = (file: string) => fs.readFile(file, "utf8").catch(() => "");

test("with the pref on, a staged update announces itself and installs without a click", async () => {
	test.setTimeout(90_000);
	const launched = await launch("on", { appAutoUpdate: true });
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
	} finally {
		await close(launched);
	}
});

test("with the pref off (the default) the staged update waits for a click", async () => {
	test.setTimeout(90_000);
	const launched = await launch("off", {});
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
