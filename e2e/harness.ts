import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Locator, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { writeFakeOmp } from "../src/main/test-fake-omp";

/**
 * Install the fake omp in `sidecar-fixture.ts` under `dir` for `OMP_GUI_OMP`,
 * shaped like a real install: an executable script on POSIX, an `omp.cmd` shim
 * (spawned through cmd.exe, in a path with a space) on Windows.
 */
export function fixtureOmp(dir: string): Promise<string> {
	const fixture = pathToFileURL(path.resolve("e2e/sidecar-fixture.ts")).href;
	return writeFakeOmp(dir, `import ${JSON.stringify(fixture)};\n`);
}

/**
 * Press an app shortcut until `target` shows. A key pressed while the renderer
 * is still mounting (slow CI runners) has no listener yet and is lost; the
 * press repeats only while the target is absent, so toggles never double-fire.
 */
export async function pressShortcutUntilVisible(page: Page, shortcut: string, target: Locator): Promise<void> {
	await expect(async () => {
		if (!(await target.isVisible())) await page.keyboard.press(shortcut);
		await expect(target).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 20_000 });
}

/**
 * Exit the app, bypassing the production quit confirmation, and wait until the
 * process is gone so Chromium stops writing the profile before it is removed.
 * The exit is scheduled after `evaluate` returns: exiting inside it races the
 * reply ("Resulting promise was garbage collected") and can mask a test's error.
 */
export async function exitApp(app: ElectronApplication): Promise<void> {
	const child = app.process();
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	await app.evaluate(({ app }) => {
		setImmediate(() => app.exit(0));
	});
	await exited;
}
