/**
 * Every user-facing entry point captured for a UX review: the session window
 * (sidebar, title bar, composer chips), the composer's + menu, the help menu,
 * the session menu, the command palette, the side panel with ⋮ View options,
 * and every Settings section (scrolled page by page), in light/dark × en/ko
 * plus a narrow window. Opt-in: `OMP_GUI_UX_CAPTURES=<dir>`; on the fake omp
 * unless `OMP_GUI_UX_REAL=1`, which runs the system omp on an empty agent dir
 * (no credentials) the way a first-time user meets it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

const CAPTURES = process.env.OMP_GUI_UX_CAPTURES ?? "";
const REAL = process.env.OMP_GUI_UX_REAL === "1";

const LABELS = {
	en: {
		add: "Attach and more",
		help: "Help",
		actions: "Session actions",
		viewOptions: "View options",
		setup: "Set up OMPdesk",
		later: "Set up later",
	},
	ko: {
		add: "첨부 및 더 보기",
		help: "도움말",
		actions: "세션 메뉴",
		viewOptions: "보기 옵션",
		setup: "OMPdesk 시작하기",
		later: "나중에 설정",
	},
} as const;

async function launch(
	language: "en" | "ko",
	theme: "light" | "dark",
): Promise<{ app: ElectronApplication; page: Page }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-ux-captures-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		...(REAL ? {} : { OMP_GUI_OMP: await fixtureOmp(profile) }),
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	if (REAL) Reflect.deleteProperty(env, "OMP_GUI_OMP");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page };
}

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
	await app.evaluate(
		({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
		{ width, height },
	);
	await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`ux captures (${language} ${theme})`, async () => {
			test.skip(!CAPTURES, "OMP_GUI_UX_CAPTURES=<dir> captures every entry point");
			test.setTimeout(240_000);
			const label = LABELS[language];
			const { app, page } = await launch(language, theme);
			const prefix = `${language}-${theme}`;
			const shot = async (name: string) => {
				await page.mouse.move(1, 1);
				await page.screenshot({
					animations: "disabled",
					path: path.join(CAPTURES, `${prefix}-${name}.png`),
					scale: "css",
				});
			};
			try {
				await fs.mkdir(CAPTURES, { recursive: true });
				if (REAL) {
					// No provider yet: the inline first-run setup takes the empty session.
					const setup = page.getByRole("region", { name: label.setup, exact: true });
					await expect(setup).toBeVisible({ timeout: 60_000 });
					await resize(app, page, 1280, 860);
					await shot("wide-00-first-run");
					await setup.getByRole("button", { name: label.later, exact: true }).click();
					await expect(setup).toHaveCount(0);
				}
				for (const [mode, width] of [
					["wide", 1280],
					["narrow", 820],
				] as const) {
					await resize(app, page, width, 860);
					await expect(page.locator(".omp-composer-input").first()).toBeVisible();
					await shot(`${mode}-01-session`);

					await page.getByRole("button", { name: label.add, exact: true }).first().click();
					await expect(page.getByRole("menu")).toBeVisible();
					await shot(`${mode}-02-plus-menu`);
					await page.keyboard.press("Escape");

					await page.getByRole("button", { name: label.actions, exact: true }).first().click();
					await expect(page.getByRole("menu")).toBeVisible();
					await shot(`${mode}-03-session-menu`);
					await page.keyboard.press("Escape");

					const help = page.locator("[data-sidebar-destinations]").getByRole("button", { name: label.help });
					if (await help.isVisible()) {
						await help.click();
						await expect(page.getByRole("menu")).toBeVisible();
						await shot(`${mode}-04-help-menu`);
						await page.keyboard.press("Escape");
					}

					await page.keyboard.press("Meta+k");
					await expect(page.getByRole("dialog")).toBeVisible();
					await shot(`${mode}-05-palette`);
					await page.keyboard.press("Escape");
					await expect(page.getByRole("dialog")).toHaveCount(0);

					// The narrow window floats the panel over the session; its menu is the same.
					if (mode === "wide") {
						await page.keyboard.press("Meta+j");
						const aside = page.locator("aside[data-docked]");
						await expect(aside).toBeVisible();
						await aside.getByRole("button", { name: label.viewOptions, exact: true }).click();
						await expect(page.getByRole("menu")).toBeVisible();
						await shot(`${mode}-06-panel-views`);
						await page.keyboard.press("Escape");
						await page.keyboard.press("Meta+j");
						await expect(aside).toHaveCount(0);
					}

					await page.keyboard.press("Meta+,");
					const settings = page.locator("[data-settings-page]");
					await expect(settings).toBeVisible();
					const sections = await settings
						.locator("[data-settings-section]")
						.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section") ?? ""));
					const limit = mode === "wide" ? sections.length : 1;
					for (const [index, section] of sections.slice(0, limit).entries()) {
						await settings.locator(`[data-settings-section="${section}"]`).click();
						await page.waitForTimeout(400);
						const content = settings.locator(".settings-content");
						const { scrollHeight, clientHeight } = await content.evaluate(node => ({
							scrollHeight: node.scrollHeight,
							clientHeight: node.clientHeight,
						}));
						const pages = Math.min(6, Math.ceil(scrollHeight / clientHeight));
						for (let part = 0; part < pages; part++) {
							await content.evaluate((node, top) => node.scrollTo({ top }), part * clientHeight);
							await shot(`${mode}-10-settings-${String(index + 1).padStart(2, "0")}-${section}-${part + 1}`);
						}
					}
					await page.keyboard.press("Escape");
				}
			} finally {
				await exitApp(app);
			}
		});
