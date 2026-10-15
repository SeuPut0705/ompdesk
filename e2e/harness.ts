import { mkdir, writeFile } from "node:fs/promises";
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
export async function fixtureOmp(dir: string): Promise<string> {
	const fixture = pathToFileURL(path.resolve("e2e/sidecar-fixture.ts")).href;
	const bin = await writeFakeOmp(dir, `import ${JSON.stringify(fixture)};\n`);
	const root = path.join(path.dirname(bin), "node_modules", "@oh-my-pi", "pi-coding-agent");
	await mkdir(root, { recursive: true });
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-coding-agent",
			type: "module",
			exports: {
				"./session/session-listing": "./session-store.ts",
				"./session/session-storage": "./session-store.ts",
				"./session/session-loader": "./session-store.ts",
				"./config/models-config-schema": "./models-config.ts",
			},
		}),
	);
	const store = pathToFileURL(path.resolve("e2e/session-store-fixture.ts")).href;
	await writeFile(path.join(root, "session-store.ts"), `export * from ${JSON.stringify(store)};\n`);
	const config = pathToFileURL(path.resolve("e2e/models-config-fixture.ts")).href;
	await writeFile(path.join(root, "models-config.ts"), `export * from ${JSON.stringify(config)};\n`);
	const catalog = path.join(path.dirname(root), "pi-catalog");
	await mkdir(catalog, { recursive: true });
	await writeFile(
		path.join(catalog, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-catalog",
			type: "module",
			exports: { "./compat/providers": "./config.ts", "./compat/auth": "./config.ts" },
		}),
	);
	await writeFile(path.join(catalog, "config.ts"), `export * from ${JSON.stringify(config)};\n`);
	const tui = path.join(path.dirname(root), "pi-tui");
	await mkdir(tui, { recursive: true });
	await writeFile(
		path.join(tui, "package.json"),
		JSON.stringify({
			name: "@oh-my-pi/pi-tui",
			type: "module",
			exports: { "./chat/transcript-entry": "./transcript-entry.ts" },
		}),
	);
	await writeFile(path.join(tui, "transcript-entry.ts"), `export * from ${JSON.stringify(store)};\n`);
	return bin;
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
 * Walk a paired host's folder picker to `folder`: up to its root, then down one
 * level at a time. Each level is found by name through the filter, since the
 * host lists a bounded number of folders per level and a crowded temp folder
 * holds more. The row is clicked once the list shows the filter's answer (every
 * name contains the part, the host's rule in `listDirectories`), as a user waits
 * for it to narrow: a click while that answer lands can hit where the row was.
 */
export async function walkRemotePicker(picker: Locator, folder: string): Promise<void> {
	const pickerPath = picker.locator("[data-remote-picker-path]");
	await expect(pickerPath).not.toHaveText("");
	const root = path.parse(folder).root;
	while ((await pickerPath.textContent()) !== root) {
		const shown = await pickerPath.textContent();
		await picker.locator("[data-remote-picker-up]").click();
		await expect(pickerPath).not.toHaveText(shown ?? "");
	}
	let current = root;
	for (const part of path.relative(root, folder).split(path.sep)) {
		current = path.join(current, part);
		const needle = part.toLocaleLowerCase();
		await picker.locator("[data-remote-picker-filter]").fill(part);
		await expect
			.poll(async () => {
				const rows = await picker
					.locator("[data-remote-dir]")
					.evaluateAll(buttons => buttons.map(button => button.getAttribute("data-remote-dir") ?? ""));
				return rows.includes(current) && rows.every(row => path.basename(row).toLocaleLowerCase().includes(needle));
			})
			.toBe(true);
		await picker.locator(`[data-remote-dir="${current}"]`).click();
		await expect(pickerPath).toHaveText(current);
	}
}

/** How long a running main process gets to act on `exitApp` before it is killed. */
const EXIT_GRACE_MS = 10_000;

/**
 * Exit the app, bypassing the production quit confirmation, and wait until the
 * process is gone so Chromium stops writing the profile before it is removed.
 * The exit is scheduled after `evaluate` returns: exiting inside it races the
 * reply ("Resulting promise was garbage collected") and can mask a test's error.
 * A main process whose thread is stuck never runs the evaluate; it is killed
 * after a grace period, so the test reports its own failure instead of the
 * worker teardown timing out.
 */
export async function exitApp(app: ElectronApplication): Promise<void> {
	const child = app.process();
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	const quit = app.evaluate(({ app }) => {
		setImmediate(() => app.exit(0));
	});
	const stuck = Promise.withResolvers<"stuck">();
	const timer = setTimeout(() => stuck.resolve("stuck"), EXIT_GRACE_MS);
	try {
		if ((await Promise.race([quit, stuck.promise])) === "stuck") {
			quit.catch(() => undefined);
			child.kill("SIGKILL");
		}
	} finally {
		clearTimeout(timer);
	}
	await exited.promise;
}
