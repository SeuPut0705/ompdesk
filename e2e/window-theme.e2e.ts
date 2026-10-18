import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { micaSupported } from "../src/main/window-chrome";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// A new window opens in the saved theme exactly like the first one, whatever the OS is set to:
// main creates every window under `nativeTheme.themeSource` = the saved scheme (the Windows Mica
// tint and caption buttons follow it), and pre-paint's color-scheme fallback answers the same.
// Playwright's own prefers-color-scheme emulation is off (`colorScheme: null`), so the media query
// reports what the app's native theme says; one of the two schemes always differs from this OS.

/** Colors of the surfaces a broken theme shows on first: canvas, sidebar chrome, workspace. */
function surfaces(page: Page) {
	return page.evaluate(() => {
		const root = document.documentElement;
		const background = (selector: string) => {
			const element = document.querySelector(selector);
			return element ? getComputedStyle(element).backgroundColor : null;
		};
		const tokens = getComputedStyle(root);
		return {
			theme: root.dataset.theme,
			mica: root.dataset.mica,
			prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
			bg: tokens.getPropertyValue("--sc-bg").trim(),
			text: tokens.getPropertyValue("--sc-text").trim(),
			surface1: tokens.getPropertyValue("--sc-surface-1").trim(),
			html: background("html"),
			body: background("body"),
			sidebar: background(".omp-session-sidebar"),
			workspace: background(".omp-workspace-main"),
		};
	});
}

for (const scheme of ["light", "dark"] as const) {
	test(`@smoke a new window opens in the saved ${scheme} theme, same as the first`, async () => {
		test.setTimeout(120_000);
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), `omp-gui-window-theme-${scheme}-`));
		const project = path.join(profile, "project");
		const desktop = path.join(profile, "desktop");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language: "en", themeName: scheme, firstRunComplete: true }),
		);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		Object.assign(env, {
			PI_CODING_AGENT_DIR: agent,
			PI_CONFIG_DIR: path.relative(os.homedir(), profile),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMP: await fixtureOmp(profile),
		});
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
			env,
			colorScheme: null,
		});
		try {
			const first = await app.firstWindow();
			const errors: string[] = [];
			first.on("pageerror", error => errors.push(error.message));
			await first.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await first.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			expect(
				await app.evaluate(({ nativeTheme }) => ({
					source: nativeTheme.themeSource,
					dark: nativeTheme.shouldUseDarkColors,
				})),
			).toEqual({ source: scheme, dark: scheme === "dark" });
			await expect.poll(() => surfaces(first).then(s => s.theme)).toBe(scheme);
			await expect(first.locator(".omp-session-sidebar")).toBeVisible();
			await expect(first.locator(".omp-workspace-main")).toBeVisible();
			const expected = await surfaces(first);
			expect(expected.prefersDark).toBe(scheme === "dark");
			expect(expected.bg).toBe(scheme === "dark" ? "#19191c" : "#ffffff");

			// The theme pre-paint gives the new document, before the renderer has read any preference.
			await app.context().addInitScript(() => {
				new MutationObserver((_records, observer) => {
					const theme = document.documentElement?.dataset.theme;
					if (!theme) return;
					Reflect.set(window, "__prePaintTheme", theme);
					observer.disconnect();
				}).observe(document, { attributes: true, childList: true, subtree: true, attributeFilter: ["data-theme"] });
			});
			expect(await first.evaluate(() => window.omp.sessions.openInNewWindow({}))).toBe(true);
			await expect.poll(() => app.windows().length, { timeout: 30_000 }).toBe(2);
			const second = app.windows().find(page => page !== first);
			if (!second) throw new Error("The new window has no page");
			second.on("pageerror", error => errors.push(error.message));
			await second.waitForFunction(() => window.omp?.rpc != null);
			expect(await second.evaluate(() => Reflect.get(window, "__prePaintTheme"))).toBe(scheme);
			await expect.poll(() => surfaces(second), { timeout: 30_000 }).toEqual(expected);
			if (process.platform === "win32") {
				expect(expected.mica).toBe(micaSupported("win32", os.release()) ? "true" : undefined);
			}
			// Picking another theme in Settings moves the native theme with it, so later windows open in that one;
			// back on System, the window settles on the OS scheme once the native theme stops forcing one.
			const other = scheme === "dark" ? "light" : "dark";
			const settings = second.locator("[data-settings-page]");
			await pressShortcutUntilVisible(second, "ControlOrMeta+Comma", settings);
			await settings.locator('[data-settings-section="appearance"]').click();
			await settings.locator(`[data-theme-option="${other}"]`).click();
			await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(other);
			await expect.poll(() => surfaces(second).then(s => s.theme)).toBe(other);
			await settings.locator('[data-theme-option="system"]').click();
			await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
			const osScheme = (await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)) ? "dark" : "light";
			await expect.poll(() => surfaces(second).then(s => s.theme)).toBe(osScheme);
			// System pairs the light and the dark theme the user picked: the one for the OS scheme shows.
			await settings.locator("#setting-gui-systemDarkTheme select").selectOption("nord");
			await settings.locator("#setting-gui-systemLightTheme select").selectOption("sepia");
			const paired = osScheme === "dark" ? { name: "nord", bg: "#2e3440" } : { name: "sepia", bg: "#f4ecd8" };
			await expect
				.poll(() => second.evaluate(() => document.documentElement.dataset.themeName))
				.toBe(paired.name);
			expect((await surfaces(second)).bg).toBe(paired.bg);
			// A theme picked by name moves the native theme to that theme's scheme.
			await settings.locator('[data-theme-option="sepia"]').click();
			await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("light");
			await expect.poll(() => surfaces(second).then(s => s.bg)).toBe("#f4ecd8");
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	});
}
