/**
 * Composer flows that cross surfaces, on the fake omp:
 *  - a steer sent while a folded paste chip and an @file card sit in the draft goes out
 *    expanded, clears the draft and both chips, and lands in the queue tray;
 *  - the completion menu is a listbox the field points at (aria-activedescendant);
 *  - a remapped shortcut shows its real chord in the command palette, runs from the palette,
 *    and fires from the keyboard (the old chord does not).
 * Captures: light/dark × en/ko.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { capture, exitApp, launchApp, recordsOfType, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: { toggle: "Toggle side panel", search: "side panel", stop: /^Stop/ },
	ko: { toggle: "사이드 패널 전환", search: "사이드 패널", stop: /^중단/ },
} as const;

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string; record: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-composer-audit-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const record = path.join(profile, "commands.jsonl");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(path.join(project, "notes.txt"), "alpha\nbravo\n");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language,
			themeName: theme,
			firstRunComplete: true,
			keymapOverrides: { "panel.toggle": ["⇧⌃Y"] },
		}),
	);
	const app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_RECORD: record } });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, record };
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`steer with paste chip and file card, completion listbox, remapped chord in the palette (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const { app, page, profile, record } = await launch(language, theme);
			const text = TEXT[language];
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator(".omp-composer-input").first();

				// A running turn to steer.
				await input.fill("fixture stream");
				await input.press("Enter");
				const stop = page.getByRole("button", { name: text.stop });
				await expect(stop).toBeVisible({ timeout: 30_000 });

				// A folded paste and an @file card in the draft.
				const pasted = Array.from({ length: 14 }, (_, index) => `pasted line ${index + 1}`).join("\n");
				await input.focus();
				await page.evaluate(content => {
					const field = document.querySelector<HTMLTextAreaElement>(".omp-composer-input");
					if (!field) throw new Error("composer missing");
					const transfer = new DataTransfer();
					transfer.setData("text/plain", content);
					field.dispatchEvent(
						new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
					);
				}, pasted);
				const inline = page.getByRole("button", { name: language === "en" ? "Paste inline" : /인라인|그대로/ });
				if (await inline.isVisible().catch(() => false)) await inline.click();
				await expect(page.locator("[data-paste-chip]")).toHaveCount(1);
				await input.pressSequentially(" @notes.txt please");
				await expect(page.locator("[data-draft-file-cards]")).toContainText("notes.txt");
				await capture(page, `${language}-${theme}-steer-draft`);

				await input.press("Enter");
				await expect(input).toHaveValue("");
				await expect(page.locator("[data-paste-chip]")).toHaveCount(0);
				await expect(page.locator("[data-draft-file-cards]")).toHaveCount(0);
				await expect(page.locator("[data-queue-pill]")).toContainText(/1/);
				await capture(page, `${language}-${theme}-steer-queued`);
				await expect.poll(async () => (await recordsOfType(record, "steer")).length).toBe(1);
				const [steer] = await recordsOfType(record, "steer");
				expect(String(steer?.message)).toContain("pasted line 14");
				expect(String(steer?.message)).toContain("@notes.txt please");
				expect(String(steer?.message)).not.toContain("[Paste #");

				// The completion menu is a listbox the field points at.
				await input.fill("/");
				const list = page.getByRole("listbox").first();
				await expect(list).toBeVisible();
				const listId = await list.getAttribute("id");
				await expect(input).toHaveAttribute("aria-controls", listId ?? "");
				const first = await list.getByRole("option").first().getAttribute("id");
				await expect(input).toHaveAttribute("aria-activedescendant", first ?? "");
				await input.press("ArrowDown");
				const second = await list.getByRole("option").nth(1).getAttribute("id");
				await expect(input).toHaveAttribute("aria-activedescendant", second ?? "");
				await capture(page, `${language}-${theme}-completion`);
				await input.press("Escape");
				await expect(list).toHaveCount(0);
				await expect(input).not.toHaveAttribute("aria-controls", /.+/);
				await input.fill("");
				await stop.click();
				await expect(stop).toHaveCount(0);

				// The remapped chord is what the palette shows, runs and the keyboard fires.
				await page.keyboard.press("ControlOrMeta+k");
				await page.keyboard.type(text.search);
				const row = page.getByRole("option", { name: new RegExp(text.toggle) });
				await expect(row).toBeVisible();
				await expect(row.locator("kbd").first()).toBeVisible();
				const chord = (await row.locator("kbd").allTextContents()).join("");
				expect(chord).toMatch(/Y/);
				expect(chord).not.toMatch(/J/);
				await capture(page, `${language}-${theme}-palette-remapped`);
				const aside = page.locator("aside[data-docked]");
				await expect(aside).toHaveCount(0);
				await page.keyboard.press("Enter");
				await expect(aside).toBeVisible();
				await page.keyboard.press("Control+Shift+y");
				await expect(aside).toHaveCount(0);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
