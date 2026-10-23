/**
 * Workbench shortcuts end to end on the fake omp (commit de199c0): ⌘1–8 / ⌘9
 * jump to a tab, ⇧⌘[ ] and ⌘PageUp/PageDown cycle, ⌘W then ⌥⌘T reopens the
 * saved session, ⌘P quick open shows a picked file in the Files viewer, and
 * ⇧⌘F finds a session by a word only its transcript holds, with the excerpt.
 * Captures in light/dark × en/ko, plus a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { exitApp, launchApp, pressShortcutUntilVisible, variants } from "./harness";
import { resize } from "./shell-capture";

// Windows moves the chords whose ⌘ form is taken there (keymap windowsDefaults): Ctrl+P and Ctrl+Alt+T are the
// model cycle and the thinking toggle.
const MAC = process.platform === "darwin";
const QUICK_OPEN = MAC ? "Meta+p" : "Control+Alt+p";
const REOPEN_TAB = MAC ? "Alt+Meta+t" : "Control+Alt+Shift+t";

for (const [language, theme] of variants([
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const)) {
	test(`tab jumps, reopen, quick open and transcript search (${language} ${theme})`, async () => {
		test.setTimeout(120_000);
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-workbench-${language}-${theme}-`));
		const desktop = path.join(root, "desktop");
		const project = path.join(root, "project");
		const agent = path.join(root, "agent");
		await Promise.all([
			fs.mkdir(desktop),
			fs.mkdir(path.join(project, "src", "beta"), { recursive: true }),
			fs.mkdir(agent),
		]);
		await Promise.all([
			fs.writeFile(path.join(project, "README.md"), "# Workbench\n"),
			fs.writeFile(path.join(project, "src", "alpha.ts"), "export const alpha = 1;\n"),
			fs.writeFile(path.join(project, "src", "beta", "gamma.ts"), "export const gamma = 3;\n"),
		]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile: root,
			env: {
				OMP_GUI_TEST_RECORD: path.join(root, "rpc.jsonl"),
				// Prompts write stock-shaped session files, so ⌥⌘T and ⇧⌘F have a saved session to find.
				OMP_GUI_TEST_SESSION_FILES: "1",
			},
		});
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		const shot = (name: string) =>
			page.screenshot({
				path: test.info().outputPath(`workbench-${language}-${theme}-${name}.png`),
				scale: "css",
				animations: "disabled",
			});
		try {
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status)
				.toBe("ready");

			// A saved session: two turns, the second one carrying the word ⇧⌘F looks for.
			const composer = page.locator('.omp-session-pane[data-active="true"] textarea');
			for (const prompt of ["Plan the release notes", "Check the haystack-marker in the changelog"]) {
				await composer.fill(prompt);
				await composer.press("Enter");
				await expect(page.locator(".omp-session-pane[data-active='true']")).toContainText(prompt);
				await expect.poll(() => activeTab(page).then(tab => tab.status)).toBe("ready");
			}
			await expect.poll(() => activeTab(page).then(tab => tab.sessionPath ?? "")).toMatch(/\.jsonl$/);
			const saved = await activeTab(page);

			const second = await openTab(page);
			const third = await openTab(page);
			const ids = [saved.tabId, second, third];

			await page.keyboard.press("ControlOrMeta+1");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[0]);
			await page.keyboard.press("ControlOrMeta+9");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[2]);
			await page.keyboard.press("ControlOrMeta+2");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[1]);
			await page.keyboard.press("ControlOrMeta+Shift+BracketLeft");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[0]);
			await page.keyboard.press("ControlOrMeta+Shift+BracketRight");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[1]);
			await page.keyboard.press("ControlOrMeta+PageDown");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[2]);
			await page.keyboard.press("ControlOrMeta+PageUp");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[1]);

			// Tab jumps pick like a sidebar click: with the last two sessions split, ⌘1 shows the
			// saved session alone, ⌘2 brings the split back, ⌘9 only moves the focus to its other pane.
			for (const [tabId, title] of [
				[second, "Second tab"],
				[third, "Third tab"],
			] as const) {
				await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
					tabId,
					`fixture:title:${title}`,
				] as const);
			}
			const thirdRow = page.locator(".omp-sidebar-session-row", { hasText: "Third tab" });
			await thirdRow.click({ button: "right" });
			await page
				.getByRole("menuitem", { name: language === "en" ? "Split right" : "오른쪽으로 분할", exact: true })
				.click();
			const panes = page.locator(".omp-session-pane");
			await expect(panes).toHaveCount(2);
			await page.keyboard.press("ControlOrMeta+1");
			await expect(panes).toHaveCount(1);
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[0]);
			await page.keyboard.press("ControlOrMeta+2");
			await expect(panes).toHaveCount(2);
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[1]);
			await shot("split-restored-by-jump");
			await page.keyboard.press("ControlOrMeta+9");
			await expect(panes).toHaveCount(2);
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[2]);

			// ⌘W on the saved session's tab, then ⌥⌘T brings that session back in a tab.
			await page.keyboard.press("ControlOrMeta+1");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(ids[0]);
			await page.keyboard.press("ControlOrMeta+w");
			await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(2);
			await page.keyboard.press(REOPEN_TAB);
			await expect
				.poll(async () =>
					(await page.evaluate(() => window.omp.tabs.list())).some(
						tab => tab.sessionPath === saved.sessionPath && tab.tabId !== saved.tabId,
					),
				)
				.toBe(true);
			await expect.poll(() => activeTab(page).then(tab => tab.sessionPath)).toBe(saved.sessionPath);

			// ⌘P: rank by file name, open the pick in the Files viewer.
			const quickOpen = page.locator("[data-quick-open]");
			await pressShortcutUntilVisible(page, QUICK_OPEN, quickOpen);
			await page.keyboard.type("gamma");
			const pick = quickOpen.locator('[data-path$="gamma.ts"]');
			await expect(pick).toBeVisible();
			await shot("quick-open");
			await page.keyboard.press("Enter");
			await expect(quickOpen).toBeHidden();
			await expect(page.locator('[title$="gamma.ts"]').first()).toBeVisible();

			// ⇧⌘F: a word only the transcript has finds the session and shows where.
			const picker = page.getByRole("dialog");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Shift+f", picker);
			await page.keyboard.type("haystack-marker");
			const hit = picker.getByRole("option").filter({ hasText: "haystack-marker" });
			await expect(hit).toBeVisible();
			// The title line is never blank, and the excerpt shows the transcript line that matched.
			await expect(hit.locator("span.block").first()).not.toBeEmpty();
			await expect(hit).toContainText("Check the haystack-marker in the changelog");
			await shot("session-search");

			if (language === "en" && theme === "light") {
				await resize(app, 560, 760);
				await expect(hit).toBeVisible();
				await shot("session-search-narrow");
				// The first Escape clears the picker's query, the second closes it.
				await page.keyboard.press("Escape");
				await page.keyboard.press("Escape");
				await expect(picker).toBeHidden();
				await pressShortcutUntilVisible(page, QUICK_OPEN, quickOpen);
				// Reopened ⌘P starts empty: typing lands on a fresh query, not "gamma".
				const field = quickOpen.getByRole("combobox");
				await expect(field).toHaveValue("");
				await expect(field).toBeFocused();
				await page.keyboard.type("alpha");
				await expect(quickOpen.locator('[data-path$="alpha.ts"]')).toBeVisible();
				await shot("quick-open-narrow");
			}
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

async function activeTab(page: Page) {
	const active = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active;
}

/** ⌘T: a new tab takes the front once its omp is ready. */
async function openTab(page: Page): Promise<string> {
	const before = (await page.evaluate(() => window.omp.tabs.list())).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(before.length + 1);
	const created = (await page.evaluate(() => window.omp.tabs.list())).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect
		.poll(
			async () =>
				(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === created.tabId)?.status,
		)
		.toBe("ready");
	await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(created.tabId);
	// Typed into, so leaving it for another tab does not close it as an empty one.
	await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Extra" }),
		created.tabId,
	);
	return created.tabId;
}
