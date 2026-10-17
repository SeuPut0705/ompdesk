/**
 * Reply actions on the fake omp with the stock PTY natives. One turn (stock
 * auto thinking classifies it high) answers with a web, a mail and a path
 * link, Korean glued to bold and to a bare URL, and a bash fence. The run
 * settings chip reads "Auto · High"; the bold survives and the URL stops
 * before the Korean; right-clicking each link offers its menu (Preview and
 * Open act); "Run in terminal" types the fence into the tab's terminal. In
 * the composer, `$` offers the fixture's skill and inserts stock's
 * `/skill:review ` token, and sending a token for a skill that is off warns.
 * Captures: light/dark × en/ko and a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { capture, exitApp, fixtureOmp, launchApp, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: {
		autoHigh: "Auto · High",
		menu: "Link actions",
		preview: "Open in Preview",
		browser: "Open in browser",
		copyLink: "Copy link",
		mail: "Open in mail app",
		copyAddress: "Copy address",
		open: "Open",
		reveal: "Reveal in Finder",
		copyPath: "Copy path",
		previewUrl: "Preview URL",
		run: "Run in terminal",
		skillOff: "The gone skill isn't on, so it goes as plain text.",
	},
	ko: {
		autoHigh: "자동 · 높음",
		menu: "링크 메뉴",
		preview: "미리보기에서 열기",
		browser: "브라우저에서 열기",
		copyLink: "링크 복사",
		mail: "메일 앱에서 열기",
		copyAddress: "주소 복사",
		open: "열기",
		reveal: "Finder에서 보기",
		copyPath: "경로 복사",
		previewUrl: "미리보기 URL",
		run: "터미널에서 실행",
		skillOff: "gone 스킬이 꺼져 있어서 일반 텍스트로 보내요.",
	},
} as const;

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-reply-actions-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(path.join(project, "src"), { recursive: true }), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(project, "src", "app.ts"), "export const fixtureEntry = 'reply actions';\n");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const bin = await fixtureOmp(profile);
	// Fake agent, real installed stock PTY, so Run in terminal reaches a shell.
	const natives =
		process.env.OMP_GUI_TEST_NATIVES ||
		path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
	await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "dir");
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_OMP: bin,
		},
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile };
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`reply link menus, CJK markdown, run in terminal, $ skills and Auto · level (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const { app, page, profile } = await launch(language, theme);
			const text = TEXT[language];
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator(".omp-composer-input").first();
				const aside = page.locator("aside[data-docked]");

				// One turn: auto thinking classifies it high, the reply carries every action.
				await input.fill("fixture reply actions");
				await input.press("Enter");
				const reply = page.locator(".omp-transcript-content .markdown-body").filter({ hasText: "0.118%" });
				await expect(reply).toBeVisible({ timeout: 30_000 });
				await expect(page.locator("[data-run-settings-trigger] .omp-composer-control-label")).toHaveText(
					text.autoHigh,
				);

				// CJK: the bold survives glued Korean; the bare URL stops before it.
				await expect(reply.locator("strong", { hasText: "0.118%" })).toHaveCount(1);
				await expect(reply.locator('a[href="https://example.com/report"]')).toHaveText(
					"https://example.com/report",
				);
				await capture(page, `${language}-${theme}-reply`);

				const menu = page.getByRole("menu", { name: text.menu });
				// Web link: Preview, browser, copy; Preview opens the panel on the URL.
				await reply.getByRole("link", { name: "the docs" }).click({ button: "right" });
				await expect(menu.getByRole("menuitem")).toHaveText([text.preview, text.browser, text.copyLink]);
				await capture(page, `${language}-${theme}-web-menu`);
				await menu.getByRole("menuitem", { name: text.preview }).click();
				await expect(menu).toHaveCount(0);
				await expect(aside.getByRole("textbox", { name: text.previewUrl })).toHaveValue("http://127.0.0.1:9/docs");

				// Mail link: mail app and copy address.
				await reply.getByRole("link", { name: "the team" }).click({ button: "right" });
				await expect(menu.getByRole("menuitem")).toHaveText([text.mail, text.copyAddress]);
				await page.keyboard.press("Escape");
				await expect(menu).toHaveCount(0);

				// Path link: open, default app, Finder, copy; Open shows the file.
				const pathLink = reply.locator('a[data-path-link="file"]', { hasText: "src/app.ts" });
				await expect(pathLink).toBeVisible({ timeout: 15_000 });
				await pathLink.click({ button: "right" });
				await expect(menu.getByRole("menuitem")).toHaveText([
					text.open,
					language === "en" ? "Open in default app" : "기본 앱으로 열기",
					text.reveal,
					text.copyPath,
				]);
				await capture(page, `${language}-${theme}-path-menu`);
				await menu.getByRole("menuitem", { name: text.open, exact: true }).click();
				await expect(aside).toContainText("fixtureEntry", { timeout: 15_000 });

				// Run in terminal: the fence reaches the tab's shell and the Terminal panel opens.
				await reply.locator(".omp-code-block").hover();
				await reply.getByRole("button", { name: text.run }).click();
				await expect
					.poll(() => aside.locator(".xterm-rows").innerText(), { timeout: 30_000 })
					.toMatch(/echo ompdesk-run-in-terminal[\s\S]*\nompdesk-run-in-terminal/);
				await capture(page, `${language}-${theme}-run-in-terminal`);

				// `$` offers the fixture's skill anywhere and inserts stock's token.
				await input.click();
				await input.fill("");
				await page.keyboard.type("please $rev");
				const option = page.getByRole("option", { name: /\$review/ });
				await expect(option).toBeVisible();
				await capture(page, `${language}-${theme}-skill-palette`);
				await page.keyboard.press("Enter");
				await expect(input).toHaveValue("please /skill:review ");

				// A token for a skill that is not on warns that it goes as plain text.
				await input.fill("fixture tokens /skill:gone now");
				await input.press("Enter");
				await expect(page.getByText(text.skillOff)).toBeVisible();
				await capture(page, `${language}-${theme}-skill-off`);

				if (language === "en" && theme === "dark") {
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
					await reply.getByRole("link", { name: "the docs" }).click({ button: "right" });
					await expect(menu).toBeVisible();
					await capture(page, "narrow-en-dark-web-menu");
					await page.keyboard.press("Escape");
					await input.fill("$");
					await expect(option).toBeVisible();
					await capture(page, "narrow-en-dark-skill-palette");
				}
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
