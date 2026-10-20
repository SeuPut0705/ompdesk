import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { micaSupported } from "../src/main/window-chrome";
import { exitApp, fixtureOmp } from "./harness";
import { describeProcess, isAiMemoryService, processTree, type WinProcess, windowsProcesses } from "./process-tree";

// What a Windows user sees when OMPdesk opens: the packaged app (dist/win-unpacked, which release.yml's win job
// has just packaged; OMP_GUI_E2E_EXE points at another OMPdesk.exe, e.g. an installed release), NOT headless
// (OMP_GUI_HEADLESS=1 makes every window transparent and would hide a blank one), on a profile with the stock
// pref defaults and no startup folder. The window must be shown on screen, the renderer must have mounted the app
// with no error, and the screen pixels inside the window must not be one flat color: a Mica window shown
// maximized stayed blank (black with a GPU, white on the runner) while the renderer had drawn the app. Screen and
// renderer captures, the renderer console, the main process output and the runtime log land in the test's
// output folder (uploaded by CI).

interface PixelStats {
	stddev: number;
	/** Share of pixels with luma below 12: a black window is ~1. */
	black: number;
	/** Distinct colors, 4 bits per channel: a blank window has one or two. */
	colors: number;
}

interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Launched {
	app: ElectronApplication;
	page: Page;
}

/** The screen pixels under `bounds`, as the user sees them (the compositor's output, Mica and all). */
function captureScreen(file: string, bounds: Bounds | null): void {
	const rect = bounds
		? `$r = New-Object System.Drawing.Rectangle ${bounds.x}, ${bounds.y}, ${bounds.width}, ${bounds.height};`
		: "$r = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;";
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			[
				"Add-Type -AssemblyName System.Windows.Forms, System.Drawing;",
				rect,
				"$bmp = New-Object System.Drawing.Bitmap $r.Width, $r.Height;",
				"$g = [System.Drawing.Graphics]::FromImage($bmp);",
				"$g.CopyFromScreen($r.Location, [System.Drawing.Point]::Empty, $r.Size);",
				`$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
			].join(" "),
		],
		{ stdio: "ignore" },
	);
}

/** Luma statistics of a PNG, decoded by Electron's nativeImage in the app's main process. */
function pixelStats(app: ElectronApplication, file: string): Promise<PixelStats> {
	return app.evaluate(({ nativeImage }, file) => {
		const bitmap = nativeImage.createFromPath(file).toBitmap(); // BGRA
		let count = 0;
		let sum = 0;
		let squares = 0;
		let black = 0;
		const colors = new Set<number>();
		for (let i = 0; i + 3 < bitmap.length; i += 4 * 3) {
			const b = bitmap[i] ?? 0;
			const g = bitmap[i + 1] ?? 0;
			const r = bitmap[i + 2] ?? 0;
			const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			count++;
			sum += luma;
			squares += luma * luma;
			if (luma < 12) black++;
			colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
		}
		const mean = count ? sum / count : 0;
		return {
			stddev: count ? Math.sqrt(Math.max(0, squares / count - mean * mean)) : 0,
			black: count ? black / count : 1,
			colors: colors.size,
		};
	}, file);
}

function windowState(app: ElectronApplication) {
	return app.evaluate(({ BrowserWindow, screen }) => {
		const windows = BrowserWindow.getAllWindows();
		const win = windows[0];
		const bounds = win?.getContentBounds() ?? { x: 0, y: 0, width: 0, height: 0 };
		// The part of the content on its display's work area: what the user can see of it.
		const { workArea } = screen.getDisplayMatching(bounds);
		const x = Math.max(bounds.x, workArea.x);
		const y = Math.max(bounds.y, workArea.y);
		const shown = {
			x,
			y,
			width: Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - x,
			height: Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - y,
		};
		return {
			count: windows.length,
			visible: win?.isVisible() ?? false,
			minimized: win?.isMinimized() ?? false,
			maximized: win?.isMaximized() ?? false,
			opacity: win?.getOpacity() ?? 0,
			onScreen: shown.width >= 400 && shown.height >= 300,
			bounds,
			shown,
		};
	});
}

/** The window is on screen and the screen shows the app inside it, not one flat (black) surface. */
async function expectDrawn({ app, page }: Launched, info: TestInfo, name: string): Promise<void> {
	const state = await windowState(app);
	expect(state, name).toMatchObject({ count: 1, visible: true, minimized: false, opacity: 1, onScreen: true });
	// Inset by the resize border, so pixels around the window never count as its content.
	const { x, y, width, height } = state.shown;
	const inset = { x: x + 16, y: y + 16, width: width - 32, height: height - 32 };
	const file = info.outputPath(`${name}-screen.png`);
	let screen: PixelStats | undefined;
	await expect
		.poll(
			async () => {
				captureScreen(file, inset);
				screen = await pixelStats(app, file);
				return screen.colors;
			},
			{ message: `${name}: the window shows one flat color on screen`, timeout: 10_000 },
		)
		.toBeGreaterThan(8);
	await info.attach(`${name}-screen`, { path: file, contentType: "image/png" });
	const rendererFile = info.outputPath(`${name}-renderer.png`);
	await page.screenshot({ path: rendererFile });
	const renderer = await pixelStats(app, rendererFile);
	await fs.appendFile(info.outputPath("captures.jsonl"), `${JSON.stringify({ name, state, screen, renderer })}\n`);
	expect(screen?.black ?? 1, `${name}: the window shows black on screen`).toBeLessThan(0.5);
	expect(screen?.stddev ?? 0, `${name}: the window shows one flat color on screen`).toBeGreaterThan(4);
	expect(renderer.colors, `${name}: the renderer drew one flat color`).toBeGreaterThan(8);
}

/** How a test ends the app: ⌘Q's teardown (`app.quit()`), or the one an update's `quitAndInstall()` runs. */
type QuitPath = "quit" | "update";

/**
 * Every named pipe libuv made (`\Device\NamedPipe\uv\<ptr>-<creator pid>`) and who holds it, then every file and pipe
 * ai-memory's service processes hold (Sysinternals Handle; CI's win-e2e sets OMP_GUI_HANDLE_EXE).
 */
function handleReport(service: WinProcess[]): string | null {
	const handle = process.env.OMP_GUI_HANDLE_EXE;
	if (!handle) return null;
	const run = (args: string[]) => {
		try {
			return execFileSync(handle, ["-accepteula", "-nobanner", "-a", ...args], {
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				timeout: 120_000,
				windowsHide: true,
			}).split(/\r?\n/);
		} catch (error) {
			return [`handle.exe ${args.join(" ")} failed: ${String(error)}`];
		}
	};
	return [
		...run(["NamedPipe"]).filter(line => line.includes("\\uv\\")),
		...service.flatMap(process => [
			`ai-memory service ${process.pid}, files and pipes:`,
			...run(["-p", String(process.pid)]).filter(line => /:\s+File\s/.test(line)),
		]),
	].join("\n");
}

/**
 * Quit the app the way `how` says, and wait until its process is closed: Playwright (like any parent reading the
 * app's output) waits for the app's stdio pipes to close, so a descendant that inherited them keeps it waiting.
 * Then nothing OMPdesk started may still run — the setup supervisor (the app's own binary as Node), an `ai-memory`
 * command it ran, omp — while ai-memory's own per-user service may, since it is designed to outlive the app.
 */
async function quitAndCheck(app: ElectronApplication, how: QuitPath, profile: string, info: TestInfo): Promise<void> {
	const launcher = app.process();
	const closed = Promise.withResolvers<"closed">();
	launcher.once("close", () => closed.resolve("closed"));
	const { pid: mainPid, exe } = await app.evaluate(() => ({ pid: process.pid, exe: process.execPath }));
	const before = windowsProcesses();
	const owned = processTree(before, mainPid).filter(process => !isAiMemoryService(process));
	const roles = [
		`Playwright worker ${process.pid}`,
		`launcher ${launcher.pid ?? "?"}`,
		`main ${mainPid}`,
		...owned.filter(process => process.pid !== mainPid).map(process => `owned ${describeProcess(process)}`),
		...before.filter(isAiMemoryService).map(process => `ai-memory service ${describeProcess(process)}`),
	];
	await fs.writeFile(info.outputPath(`processes-before-${how}.txt`), roles.join("\n"));
	await app.evaluate(({ app, autoUpdater }, how) => {
		// What electron-updater's quitAndInstall() does once its installer has started.
		setImmediate(() => {
			if (how === "update") autoUpdater.emit("before-quit-for-update");
			app.quit();
		});
	}, how);
	// A real bound on a real process: its pipes close within moments of the quit, or never.
	const timer = Promise.withResolvers<"open">();
	const timeout = setTimeout(() => timer.resolve("open"), 30_000);
	const outcome = await Promise.race([closed.promise, timer.promise]);
	clearTimeout(timeout);
	const holders = handleReport(before.filter(isAiMemoryService));
	if (holders !== null) {
		await fs.writeFile(info.outputPath(`pipe-holders-after-${how}.txt`), `${roles.join("\n")}\n\n${holders}`);
		console.log(`[${how}] process roles:\n${roles.join("\n")}\n[${how}] libuv pipes and their holders:\n${holders}`);
	}
	if (outcome === "open") {
		const now = windowsProcesses();
		throw new Error(
			`${how}: the app's process never closed (its stdio pipes stayed open) within 30 s\n${roles.join("\n")}\nnow running:\n${now
				.filter(process => process.pid !== mainPid && /omp|ai-memory/i.test(process.name))
				.map(describeProcess)
				.join("\n")}`,
		);
	}
	const ownedKeys = new Set(owned.map(process => `${process.pid}@${process.created}`));
	// The user's own omp sessions run ai-memory bridges too: one whose live parent was outside the app's tree
	// before the quit is theirs. An orphan the app left behind has no live parent, so it still counts.
	const foreign = new Set(
		before
			.filter(process =>
				before.some(
					parent =>
						parent.pid === process.ppid &&
						Number(parent.created) <= Number(process.created) &&
						!ownedKeys.has(`${parent.pid}@${parent.created}`),
				),
			)
			.map(process => `${process.pid}@${process.created}`),
	);
	const lower = (text: string | null) => (text ?? "").toLowerCase();
	const survivorsNow = () =>
		windowsProcesses().filter(
			process =>
				ownedKeys.has(`${process.pid}@${process.created}`) ||
				lower(process.exe) === lower(exe) ||
				lower(process.commandLine).includes(lower(profile)) ||
				(/^ai-memory(\.exe)?$/i.test(process.name) &&
					!isAiMemoryService(process) &&
					!foreign.has(`${process.pid}@${process.created}`)),
		);
	// The launcher's pipes close a moment before main and its Chromium children have exited (measured on Windows:
	// ~0.1 s later, both quit paths). A child that outlived the app is still there after this bound.
	let survivors = survivorsNow();
	for (const deadline = Date.now() + 10_000; survivors.length > 0 && Date.now() < deadline; survivors = survivorsNow())
		await new Promise(resolve => setTimeout(resolve, 250));
	expect(survivors.map(describeProcess), `${how}: processes OMPdesk started outlived it`).toEqual([]);
}

/** HKCU's logon entries: ai-memory's service is the `ai-memory` value. */
const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;

/**
 * Stop the ai-memory service a test's app installed (what Settings' "off" does: its logon entry, then its processes,
 * which run the copy staged in the tools dir), so the next launch starts its own.
 */
function removeAiMemoryService(): void {
	spawnSync("reg", ["delete", RUN_KEY, "/v", "ai-memory", "/f"], { stdio: "ignore", windowsHide: true });
	const staged = path.join(process.env.LOCALAPPDATA ?? "", "ompdesk", "tools", "ai-memory").toLowerCase();
	for (const running of windowsProcesses()) {
		if (!running.exe?.toLowerCase().startsWith(staged)) continue;
		spawnSync("taskkill", ["/pid", String(running.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
	}
}

/**
 * Launch the packaged app the way the Start-menu shortcut does (no folder argument) on a fresh profile, with
 * `seed` writing into its userData first, and run `body` on it; diagnostics are saved whatever happens. The packaged
 * app sets its memory up for real (the staged ai-memory.exe, its logon entry, the server): the test waits for that,
 * then quits the app by `quit` and checks what is left running.
 */
async function withPackagedApp(
	seed: (userData: string) => Promise<void>,
	quit: QuitPath,
	body: (launched: Launched, info: TestInfo) => Promise<void>,
): Promise<void> {
	const info = test.info();
	const override = process.env.OMP_GUI_E2E_EXE;
	const unpacked = path.resolve("dist/win-unpacked/OMPdesk.exe");
	const executable = override || (existsSync(unpacked) ? unpacked : null);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-first-launch-"));
	const userData = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(userData), fs.mkdir(agent)]);
	await seed(userData);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
	});
	// A real launch: shown, opaque, focusable, with its tray.
	for (const key of ["OMP_GUI_HEADLESS", "ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL"]) {
		Reflect.deleteProperty(env, key);
	}
	// ai-memory's service is global to the user: one this test's app started is stopped again at the end, so the next
	// launch starts (and is checked with) its own; one that was already there is left alone.
	const startsService =
		spawnSync("reg", ["query", RUN_KEY, "/v", "ai-memory"], { stdio: "ignore", windowsHide: true }).status !== 0;
	const mainOutput: string[] = [];
	const consoleLines: string[] = [];
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	let app: ElectronApplication | null = null;
	// Playwright's handle on a closed app has no process any more: the test's own quit leaves nothing to exit.
	let closed = false;
	try {
		const launchedApp = await electron.launch({
			...(executable ? { executablePath: executable } : {}),
			args: [
				...(executable ? [] : [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js")]),
				`--user-data-dir=${userData}`,
			],
			env,
		});
		app = launchedApp;
		app.process().once("close", () => {
			closed = true;
		});
		app.process().stdout?.on("data", chunk => mainOutput.push(String(chunk)));
		app.process().stderr?.on("data", chunk => mainOutput.push(String(chunk)));
		await app.evaluate(({ app, BrowserWindow }) => {
			const gone: string[] = [];
			Reflect.set(globalThis, "__processesGone", gone);
			const watch = (win: Electron.BrowserWindow) =>
				win.webContents.on("render-process-gone", (_event, details) =>
					gone.push(`renderer: ${details.reason} (${details.exitCode})`),
				);
			for (const win of BrowserWindow.getAllWindows()) watch(win);
			app.on("browser-window-created", (_event, win) => watch(win));
			app.on("child-process-gone", (_event, details) =>
				gone.push(`${details.type}: ${details.reason} (${details.exitCode})`),
			);
		});
		const page = await app.firstWindow({ timeout: 60_000 });
		page.on("console", message => {
			const line = `[${message.type()}] ${message.text()}`;
			consoleLines.push(line);
			if (message.type() === "error") consoleErrors.push(line);
		});
		page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
		// The renderer mounted the app: the page shows text (the setup takeover, onboarding or a session).
		await page.waitForFunction(() => (document.body.innerText ?? "").trim().length > 0, null, { timeout: 60_000 });
		await expect.poll(async () => (await windowState(launchedApp)).visible).toBe(true);

		await body({ app, page }, info);

		expect(await app.evaluate(() => Reflect.get(globalThis, "__processesGone"))).toEqual([]);
		if (await app.evaluate(({ app }) => app.isPackaged)) {
			// The packaged app's memory: the staged ai-memory.exe, ai-memory's own `setup` (its logon entry and its
			// service host, which outlives the app by design) and OMPdesk's extension root.
			const state = () => page.evaluate(() => window.omp.aiMemory.getState());
			await expect
				.poll(async () => (await state()).phase, { timeout: 240_000, message: "ai-memory never got ready" })
				.toBe("ready")
				.catch(async error => {
					throw new Error(`${String(error)}\n${JSON.stringify(await state())}`);
				});
		}
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
		await quitAndCheck(app, quit, profile, info);
	} finally {
		try {
			captureScreen(info.outputPath("desktop.png"), null);
		} catch {
			// Diagnostics only.
		}
		await fs.writeFile(info.outputPath("main-process.log"), mainOutput.join(""));
		await fs.writeFile(
			info.outputPath("renderer-console.log"),
			[...consoleLines, ...pageErrors.map(error => `[pageerror] ${error}`)].join("\n"),
		);
		await fs
			.cp(path.join(userData, "logs"), info.outputPath("userdata-logs"), { recursive: true })
			.catch(() => undefined);
		if (app && !closed) await exitApp(app);
		if (startsService) removeAiMemoryService();
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

test("@smoke Windows: the packaged app's first launch shows the app on screen, maximizing it keeps it drawn, and a quit leaves only ai-memory's service", async () => {
	test.skip(process.platform !== "win32", "the screen capture and the packaged build are the Windows job's");
	test.setTimeout(330_000);
	// No prefs.json, no window-state.json: a new user's first double-click.
	await withPackagedApp(
		async () => undefined,
		"quit",
		async (launched, info) => {
			const mica = await launched.page.evaluate(() => document.documentElement.dataset.mica);
			expect(mica).toBe(micaSupported("win32", os.release()) ? "true" : undefined);
			await expectDrawn(launched, info, "first-launch");
			// A Mica window maximized after its first show draws fine; only one shown maximized went blank.
			await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize());
			await expect.poll(async () => (await windowState(launched.app)).maximized).toBe(true);
			await expectDrawn(launched, info, "maximized");
		},
	);
});

test("@smoke Windows: a window saved maximized opens drawn on screen, not blank, and a quit for an update leaves only ai-memory's service", async () => {
	test.skip(process.platform !== "win32", "the screen capture and the packaged build are the Windows job's");
	test.setTimeout(330_000);
	// The geometry WindowManager saved when the user last closed a maximized window.
	await withPackagedApp(
		userData =>
			fs.writeFile(
				path.join(userData, "window-state.json"),
				JSON.stringify({ windowState: { x: 0, y: 0, width: 1400, height: 900, isMaximized: true } }),
			),
		"update",
		async (launched, info) => {
			expect((await windowState(launched.app)).maximized).toBe(true);
			await expectDrawn(launched, info, "saved-maximized");
			// The fix: a window that opens maximized has no Mica, so its renderer paints the whole canvas.
			expect(await launched.page.evaluate(() => document.documentElement.dataset.mica)).toBeUndefined();
			await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.unmaximize());
			await expect.poll(async () => (await windowState(launched.app)).maximized).toBe(false);
			await expectDrawn(launched, info, "restored");
		},
	);
});
