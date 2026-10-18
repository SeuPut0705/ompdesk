import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type TestInfo, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import { micaSupported } from "../src/main/window-chrome";
import { exitApp, fixtureOmp } from "./harness";

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

/**
 * Launch the packaged app the way the Start-menu shortcut does (no folder argument) on a fresh profile, with
 * `seed` writing into its userData first, and run `body` on it; diagnostics are saved whatever happens.
 */
async function withPackagedApp(
	seed: (userData: string) => Promise<void>,
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

	const mainOutput: string[] = [];
	const consoleLines: string[] = [];
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	let app: ElectronApplication | null = null;
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
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
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
		if (app) await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

test("@smoke Windows: the packaged app's first launch shows the app on screen, and maximizing it keeps it drawn", async () => {
	test.skip(process.platform !== "win32", "the screen capture and the packaged build are the Windows job's");
	test.setTimeout(90_000);
	// No prefs.json, no window-state.json: a new user's first double-click.
	await withPackagedApp(
		async () => undefined,
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

test("@smoke Windows: a window saved maximized opens drawn on screen, not blank", async () => {
	test.skip(process.platform !== "win32", "the screen capture and the packaged build are the Windows job's");
	test.setTimeout(90_000);
	// The geometry WindowManager saved when the user last closed a maximized window.
	await withPackagedApp(
		userData =>
			fs.writeFile(
				path.join(userData, "window-state.json"),
				JSON.stringify({ windowState: { x: 0, y: 0, width: 1400, height: 900, isMaximized: true } }),
			),
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
