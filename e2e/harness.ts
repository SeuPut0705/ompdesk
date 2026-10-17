import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
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

/** Where one launch of the built app lives: every path is the test's own (a `mkdtemp` profile). */
export interface LaunchOptions {
	/** The folder the app opens. */
	project: string;
	/** userData (`--user-data-dir`). */
	desktop: string;
	/** omp's agent dir (`PI_CODING_AGENT_DIR`). */
	agent: string;
	/** The test's private root: `PI_CONFIG_DIR` (relative to the home dir) and where the fake omp is installed. */
	profile: string;
	/**
	 * Added to the app's environment over the defaults; `undefined` removes a variable (`OMP_GUI_OMP: undefined`
	 * runs the system omp instead of the fake one).
	 */
	env?: Record<string, string | undefined>;
	/** Arguments after the userData flag. */
	args?: string[];
}

/**
 * Launch the built app (`out/main/index.js`) on `project` with its own userData, omp agent and config dirs, no
 * omp profile, and the fake omp (`fixtureOmp`) unless `env` names `OMP_GUI_OMP`. `ELECTRON_RUN_AS_NODE`, which an
 * Electron-hosted runner exports, never reaches the app.
 */
export async function launchApp(options: LaunchOptions): Promise<ElectronApplication> {
	const extra = options.env ?? {};
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: options.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), options.profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		...("OMP_GUI_OMP" in extra ? {} : { OMP_GUI_OMP: await fixtureOmp(options.profile) }),
		...extra,
	};
	const launchEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") launchEnv[key] = value;
	}
	return electron.launch({
		args: [
			path.resolve("out/main/index.js"),
			options.project,
			`--user-data-dir=${options.desktop}`,
			...(options.args ?? []),
		],
		env: launchEnv,
	});
}

/** A screenshot of `page` in the test's output dir (`<name>.png`), CSS pixels, animations stopped. */
export async function capture(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled", scale: "css" });
}

/** {@link capture} into `directory` instead, only when one is set (an opt-in capture env var). */
export async function captureTo(directory: string | undefined, page: Page, name: string): Promise<void> {
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	await page.screenshot({ path: path.join(directory, `${name}.png`), scale: "css", animations: "disabled" });
}

/** Every record of a JSONL file the fake omp writes (`OMP_GUI_TEST_RECORD`), in order; none before it exists. */
export async function readRecords(file: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

/** The records of `file` whose `type` is `type`. */
export async function recordsOfType(file: string, type: string): Promise<Record<string, unknown>[]> {
	return (await readRecords(file)).filter(record => record.type === type);
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
 * Press an app shortcut until `done` holds, for a shortcut that is not a toggle (⌘T opens a tab each time):
 * the press repeats only while `done` is false, so a lost key (the renderer still mounting) is sent again and
 * a delivered one never doubles.
 */
export async function pressShortcutUntil(page: Page, shortcut: string, done: () => Promise<boolean>): Promise<void> {
	await expect(async () => {
		if (!(await done())) await page.keyboard.press(shortcut);
		await expect.poll(done, { timeout: 2_000 }).toBe(true);
	}).toPass({ timeout: 20_000 });
}

/**
 * Open a sidebar destination page. The footer's Agents and Stats entries are off by default, so without them the
 * page opens the way a user without the pins does: ⌥A for Agents, the command palette for Stats. Both shortcuts
 * repeat until their target shows, since one pressed while the renderer still mounts is lost.
 */
export async function openDestination(
	page: Page,
	destination: "agents" | "insights" | "settings",
	paletteQuery = "stats",
): Promise<void> {
	const button = page.locator(`[data-sidebar-destinations] button[data-destination="${destination}"]`);
	if (await button.isVisible()) return button.click();
	const target = page.locator(`section[data-destination="${destination}"]`);
	if (destination === "agents") return pressShortcutUntilVisible(page, "Alt+KeyA", target);
	const search = page.getByRole("dialog").getByRole("searchbox");
	await pressShortcutUntilVisible(page, "ControlOrMeta+k", search);
	await search.fill(paletteQuery);
	await search.press("Enter");
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
