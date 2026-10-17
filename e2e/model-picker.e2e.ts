/**
 * The composer's model picker is dense: a compact search focused on open,
 * one-line rows (provider mark + name + muted context size), small-caps group
 * headers, a bounded height that scrolls, arrow/Enter keys. Fake omp with two
 * providers (fixture + the signed-in Anthropic of `OMP_GUI_TEST_MODELS`).
 * Captures: en/ko × light/dark (test output directory; set MODEL_PICKER_SHOTS=<dir> to also copy them there).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const RUNS = [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const satisfies ReadonlyArray<readonly [Language, Theme]>;

const SEARCH = { en: "Search models", ko: "모델 검색" } as const;

let profile: string | null = null;
let app: ElectronApplication | null = null;

test.afterEach(async () => {
	if (app) await exitApp(app);
	app = null;
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	profile = null;
});

async function launch(language: Language, theme: Theme, size: { width: number; height: number }): Promise<Page> {
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-model-picker-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_LOGIN: "1",
			OMP_GUI_TEST_MODELS: "1",
		},
	});
	const page = await app.firstWindow();
	await app.evaluate(
		({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height),
		size,
	);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return page;
}

async function capture(page: Page, name: string): Promise<void> {
	const file = test.info().outputPath(`${name}.png`);
	await page.screenshot({ path: file, animations: "disabled", scale: "css" });
	const copyTo = process.env.MODEL_PICKER_SHOTS;
	if (copyTo) {
		await fs.mkdir(copyTo, { recursive: true });
		await fs.copyFile(file, path.join(copyTo, `${name}.png`));
	}
}

for (const [language, theme] of variants(RUNS)) {
	test(`the model picker is dense: focused search, one-line rows, bounded height, keys (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const page = await launch(language, theme, { width: 1280, height: 860 });
		await page.locator("[data-model-chip]").click();
		const dialog = page.getByRole("dialog");
		const search = dialog.getByRole("searchbox", { name: SEARCH[language] });
		await expect(search).toBeFocused();

		const options = dialog.getByRole("option");
		expect(await options.count()).toBeGreaterThan(2);
		// One line per row, at the small control height at most.
		for (const box of await options.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))) {
			expect(box).toBeLessThanOrEqual(29);
		}
		await expect(options.first().locator("[data-provider-mark]")).toBeVisible();
		const panel = await dialog.boundingBox();
		expect(panel?.height ?? 0).toBeLessThan(560);
		expect(panel?.width ?? 0).toBeLessThan(500);
		await capture(page, `model-picker-${language}-${theme}`);

		// Arrows move the highlight; type-to-filter narrows to one row and Enter picks it, closing the picker.
		await search.press("ArrowDown");
		await expect(search).toHaveAttribute("aria-activedescendant", /option-1$/);
		await search.press("ArrowUp");
		await search.fill("local");
		await expect(options).toHaveCount(1);
		await search.press("Enter");
		await expect(dialog).toBeHidden();
	});

	test(`the model picker stays inside a narrow window (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const page = await launch(language, theme, { width: 520, height: 520 });
		await page.locator("[data-model-chip]").click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByRole("searchbox", { name: SEARCH[language] })).toBeFocused();
		const box = await dialog.boundingBox();
		const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
		expect(box).not.toBeNull();
		expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
		expect((box?.y ?? -1) + (box?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
		await capture(page, `model-picker-narrow-${language}-${theme}`);
	});
}
