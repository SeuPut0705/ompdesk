/**
 * The composer's + menu is compact actions only (attach, history, expand, goal)
 * plus one "Use a skill…" entry that opens a searchable picker above the input:
 * one line per skill (name + ellipsized description, full text in the
 * tooltip), a search field, arrow keys and Enter, never taller than 60vh. The
 * `/` menu keeps its rows on one line too. Fake omp; the fixture's skills carry
 * multi-paragraph descriptions. Captures: light/dark × en/ko.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { capture, exitApp, fixtureOmp, launchApp, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: { add: "Attach and more", skills: "Use a skill…", search: "Search skills", picker: "Skills" },
	ko: { add: "첨부 및 더 보기", skills: "스킬 사용…", search: "스킬 검색", picker: "스킬" },
} as const;

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-skill-picker-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const bin = await fixtureOmp(profile);
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
		test(`+ menu is compact and skills open in a one-line picker (${language} ${theme})`, async () => {
			test.setTimeout(120_000);
			const { app, page, profile } = await launch(language, theme);
			const text = TEXT[language];
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator(".omp-composer-input").first();
				const viewportHeight = (await page.viewportSize())?.height ?? 860;

				// The + menu: Attach, History, Dictation (off in this profile) and one skills entry, no skill rows, above the
				// composer, under 60vh. Expand composer and Set a goal left it (⌃G and the Mode popover hold them).
				await page.getByRole("button", { name: text.add }).click();
				const menu = page.getByRole("menu", { name: text.add });
				await expect(menu.getByRole("menuitem")).toHaveCount(4);
				await expect(menu.getByRole("menuitem").last()).toContainText(text.skills);
				await expect(menu).not.toContainText("agent-reach");
				const menuBox = await menu.boundingBox();
				const inputBox = await input.boundingBox();
				expect(menuBox?.height ?? 0).toBeLessThanOrEqual(viewportHeight * 0.6);
				const triggerBox = await page.getByRole("button", { name: text.add }).boundingBox();
				expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(triggerBox?.y ?? 0);
				await capture(page, `${language}-${theme}-plus-menu`);

				// The picker: one line per skill, search, keyboard.
				await menu.getByRole("menuitem", { name: text.skills }).click();
				const picker = page.getByRole("dialog", { name: text.picker });
				await expect(picker).toBeVisible();
				const rows = picker.getByRole("option");
				await expect(rows).toHaveCount(6);
				const heights = await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
				for (const height of heights) expect(height).toBeLessThanOrEqual(36);
				const reach = picker.locator('[data-skill-row="agent-reach"]');
				await expect(reach).toHaveAttribute("title", /Supports many platforms/);
				const truncated = await reach
					.locator("[data-skill-description]")
					.evaluate(node => node.scrollWidth > node.clientWidth);
				expect(truncated).toBe(true);
				const pickerBox = await picker.boundingBox();
				expect(pickerBox?.height ?? 0).toBeLessThanOrEqual(viewportHeight * 0.6);
				expect((pickerBox?.y ?? 0) + (pickerBox?.height ?? 0)).toBeLessThanOrEqual(inputBox?.y ?? 0);
				await capture(page, `${language}-${theme}-skill-picker`);

				await picker.getByRole("searchbox", { name: text.search }).fill("caveman");
				await expect(rows).toHaveCount(2);
				await capture(page, `${language}-${theme}-skill-picker-search`);
				await page.keyboard.press("ArrowDown");
				await page.keyboard.press("Enter");
				await expect(picker).toHaveCount(0);
				await expect(input).toHaveValue("/skill:caveman-commit ");

				// The / menu keeps one line per skill and a tooltip with the full text.
				await input.fill("/skill:a");
				const slashRow = page.getByRole("option", { name: /skill:agent-reach/ });
				await expect(slashRow).toBeVisible();
				const slashHeight = await slashRow.evaluate(node => node.getBoundingClientRect().height);
				expect(slashHeight).toBeLessThanOrEqual(40);
				await expect(slashRow).toHaveAttribute("title", /Supports many platforms/);
				await capture(page, `${language}-${theme}-slash-skills`);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
