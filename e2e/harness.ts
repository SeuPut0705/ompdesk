import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { assertAppBuilt } from "../scripts/e2e-app-entry";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { withoutGitSelectors } from "../src/shared/git-env";
import { processesBelow, waitForProcessesToExit } from "./process-tree";

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
				"./utils/image-resize": "./image-convert.ts",
				"./config/settings": "./worktree-location.ts",
				"./task/settings": "./worktree-location.ts",
			},
		}),
	);
	const store = pathToFileURL(path.resolve("e2e/session-store-fixture.ts")).href;
	await writeFile(path.join(root, "session-store.ts"), `export * from ${JSON.stringify(store)};\n`);
	const config = pathToFileURL(path.resolve("e2e/models-config-fixture.ts")).href;
	await writeFile(path.join(root, "models-config.ts"), `export * from ${JSON.stringify(config)};\n`);
	const images = pathToFileURL(path.resolve("e2e/image-convert-fixture.ts")).href;
	await writeFile(path.join(root, "image-convert.ts"), `export * from ${JSON.stringify(images)};\n`);
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
			exports: { "./chat/transcript-entry": "./transcript-entry.ts", "./chat/image-loading": "./image-convert.ts" },
		}),
	);
	await writeFile(path.join(tui, "transcript-entry.ts"), `export * from ${JSON.stringify(store)};\n`);
	await writeFile(path.join(tui, "image-convert.ts"), `export * from ${JSON.stringify(images)};\n`);
	const location = pathToFileURL(path.resolve("e2e/worktree-location-fixture.ts")).href;
	await writeFile(path.join(root, "worktree-location.ts"), `export * from ${JSON.stringify(location)};\n`);
	const utils = path.join(path.dirname(root), "pi-utils");
	await mkdir(utils, { recursive: true });
	await writeFile(
		path.join(utils, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-utils", type: "module", exports: { ".": "./worktree-location.ts" } }),
	);
	await writeFile(path.join(utils, "worktree-location.ts"), `export * from ${JSON.stringify(location)};\n`);
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
 * What `launchApp` hands Electron: the built app (`out/main/index.js`) on `project` with its own userData, omp
 * agent and config dirs, no omp profile, and the fake omp (`fixtureOmp`) unless `env` names `OMP_GUI_OMP`.
 * `ELECTRON_RUN_AS_NODE`, which an Electron-hosted runner exports, never reaches the app.
 */
export async function appLaunchOptions(
	options: LaunchOptions,
): Promise<{ args: string[]; env: Record<string, string> }> {
	const extra = options.env ?? {};
	const env: Record<string, string | undefined> = {
		// The app must never inherit a leaked GIT_DIR or its kin (src/shared/git-env.ts).
		...withoutGitSelectors(process.env),
		PI_CODING_AGENT_DIR: options.agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), options.profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		...("OMP_GUI_OMP" in extra ? {} : { OMP_GUI_OMP: await fixtureOmp(options.profile) }),
		// Machine setup's managed tools dir is `%LOCALAPPDATA%\ompdesk\tools` on Windows (`managedToolsDir`), one
		// folder for every app on the PC. A launch that downloads through the test installer has its own, or a
		// parallel app renames its `.downloads/test-download.part` away and the install fails before it runs.
		...(process.platform === "win32" && "OMP_GUI_TEST_DOWNLOAD" in extra
			? { LOCALAPPDATA: path.join(options.profile, "localappdata") }
			: {}),
		...extra,
	};
	const launchEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") launchEnv[key] = value;
	}
	const entry = assertAppBuilt();
	return {
		args: [entry, options.project, `--user-data-dir=${options.desktop}`, ...(options.args ?? [])],
		env: launchEnv,
	};
}

/** Launch the built app as {@link appLaunchOptions} describes. */
export async function launchApp(options: LaunchOptions): Promise<ElectronApplication> {
	return electron.launch(await appLaunchOptions(options));
}

/**
 * The theme, language, size or device variants a test is registered for. The default run keeps one
 * (the first, or those `keep` accepts) because the others only re-check rendering; `OMP_GUI_VARIANTS=1`
 * registers every variant, for captures and the occasional full sweep. Unregistered variants do not
 * show as skipped and do not weigh on `scripts/e2e-shard.ts`.
 */
export function variants<T>(all: readonly T[], keep: (item: T) => boolean = item => item === all[0]): readonly T[] {
	return process.env.OMP_GUI_VARIANTS === "1" ? all : all.filter(keep);
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
 * The main agent of `page`'s focused tab (or of `tabId`) calls an OMPdesk control tool (the fake omp runs
 * `fixture:host-tool:<name> <json>` and records the `host_tool_result` it gets in `record`);
 * resolves with the result the agent gets back.
 */
export async function controlToolCaller(page: Page, record: string, tabId?: string) {
	const tabs = await page.evaluate(() => window.omp.tabs.list());
	const main = tabId ?? tabs.find(tab => tab.active)?.tabId ?? "";
	expect(main).not.toBe("");
	const results = async () =>
		(await readRecords(record))
			.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
			.map(frame => {
				const result = frame.result as { content?: { text?: string }[] } | undefined;
				return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
			});
	return async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
		const before = (await results()).length;
		const response = await page.evaluate(
			([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
			[main, `fixture:host-tool:${name} ${JSON.stringify(args)}`] as const,
		);
		expect(response).toMatchObject({ success: true });
		await expect.poll(async () => (await results()).length, { timeout: 90_000 }).toBe(before + 1);
		return (await results())[before] as { text: string; isError: boolean };
	};
}

/** The session ids an `ompdesk_session_open` result names. */
export function openedSessions(text: string): string[] {
	return [...text.matchAll(/Opened session (\w+)/g)].map(match => match[1] ?? "");
}

/**
 * Press an app shortcut and wait for `target`. A key pressed while the renderer is still mounting has no listener
 * and is lost, so it is sent again, but only after a long wait: a slow runner may take seconds to show a page the
 * first press already opened, and a quick second press would toggle it shut again.
 */
export async function pressShortcutUntilVisible(page: Page, shortcut: string, target: Locator): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await target.isVisible()) return;
		await page.keyboard.press(shortcut);
		if (
			await target.waitFor({ state: "visible", timeout: 12_000 }).then(
				() => true,
				() => false,
			)
		)
			return;
	}
	await expect(target).toBeVisible({ timeout: 1_000 });
}

/**
 * Show the first session's family rows (its subagents and the sessions its agent opened). A family is folded until the
 * person opens it and never opens by itself, so the chip is pressed only when it says the rows are folded.
 */
export async function openSidebarFamily(page: Page): Promise<void> {
	const chip = page.locator("[data-sidebar-subagents-toggle]").first();
	await expect(chip).toBeVisible({ timeout: 15_000 });
	if ((await chip.getAttribute("aria-expanded")) === "false") await chip.click();
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
 * `value` as a quoted CSS attribute-selector string. A Windows path's backslashes are CSS escapes
 * (`"C:\Users"` reads as `C:Users` with a `\U` escape), so a raw path in `[data-x="…"]` matches nothing there.
 */
export function cssString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
		await picker.locator(`[data-remote-dir=${cssString(current)}]`).click();
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
 *
 * On Windows a process keeps the folder it works in from being removed, and the launcher exits before the app
 * under it has: main, Chromium's helpers, the omp it started, that omp's MCP servers and the git it ran wind
 * down for another ~0.1 s (measured: the omp and its `npx` chain were alive when `exitApp` returned, and the
 * spec's `fs.rm(profile)` failed `EBUSY` on `project`, 5 of 24 runs of `real-core.e2e.ts`). So the processes
 * below the launcher are listed before the exit and waited for after it; one still running after the grace
 * period is killed.
 */
export async function exitApp(app: ElectronApplication): Promise<void> {
	// A killed app (a spec's crash) has closed its Playwright connection: `process()` then throws, and a `finally`
	// that cleans up after it would replace the test's own error with that one (nightly 39510409009).
	let child: ChildProcess;
	try {
		child = app.process();
	} catch {
		return;
	}
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const owned = child.pid === undefined ? [] : processesBelow(child.pid);
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
	} catch (error) {
		// A spec that killed the app (SIGKILL) and then failed ends here with the app gone: wait for the launcher below
		// rather than let "Target closed" replace the spec's own failure in the report.
		if (!String(error).includes("has been closed")) throw error;
	} finally {
		clearTimeout(timer);
	}
	await exited.promise;
	await waitForProcessesToExit(owned, EXIT_GRACE_MS);
}

/** What a drawn box and a finger each reach, in CSS px. */
export interface HitSize {
	label: string;
	visual: { width: number; height: number };
	hit: { width: number; height: number };
}

/**
 * Wait until no finite animation runs on the matched elements or their ancestors. A popover's pop-in (`omp-pop-in`,
 * scale 0.95) and a dialog's (`omp-scale-in`, 0.93) shrink every box inside it until they end, and a loaded runner
 * can hold that first frame longer than a "settled box" poll waits: a 44 px row measured 41.8. Endless cues (the
 * working shimmer) are left out; a stalled animation is waited for 3 s at most.
 */
export async function animationsDone(locator: Locator): Promise<void> {
	await locator.evaluateAll(async nodes => {
		const running = new Set<Animation>();
		for (const node of nodes)
			for (let element: Element | null = node; element; element = element.parentElement)
				for (const animation of element.getAnimations())
					if (Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))) running.add(animation);
		const cap = Promise.withResolvers<void>();
		setTimeout(cap.resolve, 3000);
		await Promise.race([
			Promise.all([...running].map(animation => animation.finished.catch(() => undefined))),
			cap.promise,
		]);
	});
}

/**
 * The mobile shell keeps controls small and gives each an invisible `::after` that reaches `--sc-touch-target`
 * (mobile.css): every visible match's drawn box next to the larger of it and that pseudo-element (a stretched row
 * link's `::after` covers its row), so a test can pin "dense to look at, 44 px to hit".
 */
export async function hitSizes(locator: Locator): Promise<HitSize[]> {
	await animationsDone(locator);
	return locator.evaluateAll(nodes =>
		nodes.flatMap(node => {
			const box = node.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) return [];
			const after = getComputedStyle(node, "::after");
			const reach = after.content !== "none" && after.position === "absolute";
			return [
				{
					label: node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 30) ?? node.tagName,
					visual: { width: box.width, height: box.height },
					hit: {
						width: Math.max(box.width, reach ? Number.parseFloat(after.width) : 0),
						height: Math.max(box.height, reach ? Number.parseFloat(after.height) : 0),
					},
				},
			];
		}),
	);
}
