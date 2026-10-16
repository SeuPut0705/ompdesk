import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { micaSupported } from "../src/main/window-chrome";
import { captureTo, exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// Surfaces the release workflow's @smoke run covers on every platform beside smoke.e2e.ts, on the
// fake omp: the Model roles page, a file edited in the Files panel, and (Windows only) the Mica
// backdrop and close-to-tray. OMP_GUI_DESKTOP_CAPTURES=<dir> keeps their captures.

const CAPTURES = process.env.OMP_GUI_DESKTOP_CAPTURES ?? "";

interface Launched {
	app: ElectronApplication;
	page: Page;
	profile: string;
	project: string;
	desktop: string;
	env: Record<string, string>;
	errors: string[];
}

async function launch(
	name: string,
	prefs: Record<string, unknown>,
	seed: (project: string) => Promise<void> = async () => undefined,
	extraEnv: Record<string, string> = {},
	content: [number, number] = [1280, 860],
): Promise<Launched> {
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-${name}-`));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await seed(project);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, ...prefs }),
	);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		...extraEnv,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }, [width, height]) => {
		const win = BrowserWindow.getAllWindows()[0];
		win?.setContentSize(width, height);
		win?.setPosition(0, 0);
	}, content);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, project, desktop, env, errors };
}

async function close(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

/** The whole primary screen: the only capture that shows what the compositor draws behind the window (Mica). */
function captureDesktop(name: string): void {
	if (!CAPTURES || process.platform !== "win32") return;
	const file = path.join(CAPTURES, `${name}.png`);
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			[
				"Add-Type -AssemblyName System.Windows.Forms, System.Drawing;",
				"$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;",
				"$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;",
				"$g = [System.Drawing.Graphics]::FromImage($bmp);",
				"$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);",
				`$bmp.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`,
			].join(" "),
		],
		{ stdio: "ignore" },
	);
}

test("@smoke Model roles lists every purpose with its use, and a role is set through the picker", async () => {
	test.setTimeout(120_000);
	// The fixture's Models page data (signed-in provider, roles, candidates) is behind these two switches.
	const launched = await launch("roles", {}, undefined, { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" });
	try {
		const { page } = launched;
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="models"]').click();
		const roles = settings.locator("#settings-models-roles");
		await expect(roles.locator("[data-setting-row]").first()).toBeVisible();
		for (const group of ["Conversation", "Agent work"])
			await expect(roles.getByRole("group", { name: group })).toBeVisible();
		// A configured role shows when it is used and the model it runs on; an empty one what it follows.
		await expect(roles.locator("#model-role-default")).toContainText("Answers every message in a session");
		await expect(roles.locator("#model-role-default")).toContainText("Claude Sonnet 4.5");
		await expect(roles.locator("#model-role-smol")).toContainText("Quick, cheap work");
		await captureTo(CAPTURES, page, "model-roles");

		await roles.getByRole("button", { name: "Model for Fast", exact: true }).click();
		await page
			.getByRole("option", { name: /local-fixture/ })
			.first()
			.click();
		await expect(page.getByText(/Role "Fast" set to /)).toBeVisible();
		await expect(roles.locator("#model-role-smol")).toContainText("Local fixture");
		await captureTo(CAPTURES, page, "model-roles-set");
		expect(launched.errors).toEqual([]);
	} finally {
		await close(launched);
	}
});

test("@smoke Files panel edits a file in place with Ctrl+S and keeps the edit when the disk changes under it", async () => {
	test.setTimeout(120_000);
	const launched = await launch("files-edit", {}, async project => {
		await fs.writeFile(path.join(project, "notes.md"), "# Notes\n");
	});
	try {
		const { page, project } = launched;
		const aside = page.locator("aside[data-docked]");
		await page.getByRole("button", { name: "Side panel", exact: true }).click();
		await expect(aside).toBeVisible();
		await aside.getByRole("button", { name: "Files", exact: true }).click();
		await aside.locator('[data-tree-id="file:notes.md"]').click();
		await expect(aside.getByText("Notes", { exact: true }).first()).toBeVisible();

		await aside.getByRole("button", { name: "Edit", exact: true }).click();
		const editor = aside.getByRole("textbox", { name: "Contents of notes.md", exact: true });
		await expect(editor).toBeFocused();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("Edited in OMPdesk\n");
		const status = aside.locator("[data-editor-status]");
		await expect(status).toHaveText("Unsaved");
		await page.keyboard.press("ControlOrMeta+s");
		await expect(status).toHaveText("Saved");
		// Windows writes through a temp file and a rename: the bytes must be exactly what was typed, no CR added.
		expect(await fs.readFile(path.join(project, "notes.md"), "utf8")).toBe("# Notes\nEdited in OMPdesk\n");
		await expect(aside.locator("[data-file-meta]")).toContainText("26 B");
		await captureTo(CAPTURES, page, "files-edit");

		await page.keyboard.type("draft");
		await fs.writeFile(path.join(project, "notes.md"), "# Someone else\n");
		await expect(
			aside.getByText("This file changed on disk since you opened it. Your edits are still here."),
		).toBeVisible({ timeout: 15_000 });
		await aside.getByRole("button", { name: "Load the disk version", exact: true }).click();
		await expect(editor).toContainText("# Someone else");
		await expect(status).toHaveText("Saved");
		expect(launched.errors).toEqual([]);
	} finally {
		await close(launched);
	}
});

test("@smoke Windows: the Mica backdrop is on where the build has it, and closing the window hides it to the tray", async () => {
	test.skip(process.platform !== "win32", "Mica and the tray are Windows features");
	test.setTimeout(120_000);
	// Not headless: the tray exists only in a real run (OMP_GUI_HEADLESS=1 skips it), and the window is really shown.
	// Sized to fit the runner's 1024×768 screen, so the desktop capture shows the whole window and its caption buttons.
	// Close-to-tray is on by default: no pref is written.
	const launched = await launch("tray", {}, undefined, { OMP_GUI_HEADLESS: "0" }, [1000, 680]);
	try {
		const { app, page } = launched;
		const windowState = () =>
			app.evaluate(({ BrowserWindow }) => {
				const windows = BrowserWindow.getAllWindows();
				const win = windows[0];
				return {
					count: windows.length,
					destroyed: win?.isDestroyed() ?? true,
					visible: win?.isVisible() ?? false,
					minimized: win?.isMinimized() ?? false,
					width: win?.getBounds().width ?? 0,
				};
			});

		// Mica: main asked for the backdrop (`?mica=1`) exactly on Windows 11 22H2+, and the renderer reacted.
		const mica = micaSupported("win32", os.release());
		const chrome = await page.evaluate(() => ({
			platform: document.documentElement.dataset.platform,
			mica: document.documentElement.dataset.mica,
			background: getComputedStyle(document.body).backgroundColor,
		}));
		expect(chrome.platform).toBe("win32");
		expect(chrome.mica).toBe(mica ? "true" : undefined);
		if (mica) expect(chrome.background).toBe("rgba(0, 0, 0, 0)");
		expect(await windowState()).toMatchObject({ count: 1, destroyed: false, visible: true, minimized: false });
		expect((await windowState()).width).toBeGreaterThan(900);
		await captureTo(CAPTURES, page, "mica");
		captureDesktop("mica-desktop");

		// Close to tray: the window hides, nothing is destroyed, the session keeps answering.
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
		await expect.poll(windowState).toMatchObject({ count: 1, destroyed: false, visible: false });
		expect(launched.app.process().exitCode).toBeNull();
		expect((await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");

		// A second launch from the Start menu hands over to this instance and brings the window back.
		const executable = await app.evaluate(() => process.execPath);
		const second = spawn(executable, [path.resolve("out/main/index.js"), `--user-data-dir=${launched.desktop}`], {
			env: launched.env,
			stdio: "ignore",
			windowsHide: true,
		});
		const secondExit = new Promise<number | null>(resolve => second.once("exit", code => resolve(code)));
		await expect.poll(windowState, { timeout: 30_000 }).toMatchObject({ count: 1, visible: true });
		await secondExit;
		await captureTo(CAPTURES, page, "tray-restored");
		captureDesktop("tray-restored-desktop");
		expect(launched.errors).toEqual([]);
	} finally {
		await close(launched);
	}
});
