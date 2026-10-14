/**
 * Composer keys, focus hand-off and the context popover's actions, on the fake
 * omp. ⌃J inserts a newline and ⌃U deletes back to the line start; Esc on a
 * draft shows "Esc again" and a second Esc clears it into ↑ history; a double
 * Esc on an empty composer opens stock's rewind picker (`doubleEscapeAction`
 * default). Printable keys typed on the focused transcript land in the
 * composer, and PageUp in the composer pages the transcript. The context
 * popover compacts through stock `compact` and opens the handoff dialog.
 * Captures: light/dark × en/ko and a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: {
		escHint: "Press Esc again to clear the draft. ↑ brings it back.",
		rewind: "Search messages",
		compact: "Compact now",
		handoff: "Hand off to a new session",
		compacted: "Compacted",
	},
	ko: {
		escHint: "Esc를 한 번 더 누르면 초안을 지워요. ↑로 다시 불러올 수 있어요.",
		rewind: "메시지 검색",
		compact: "지금 압축",
		handoff: "새 세션으로 넘기기",
		compacted: "압축 완료",
	},
} as const;

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string; record: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-composer-keys-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const record = path.join(profile, "commands.jsonl");
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
		OMP_GUI_OMP: await fixtureOmp(profile),
		OMP_GUI_TEST_RECORD: record,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, record };
}

async function recorded(file: string, type: string): Promise<number> {
	const text = await fs.readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.filter(line => {
			const frame: unknown = JSON.parse(line);
			return typeof frame === "object" && frame !== null && "type" in frame && frame.type === type;
		}).length;
}

async function capture(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: "disabled", scale: "css" });
}

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`composer keys, focus hand-off and context actions (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const { app, page, profile, record } = await launch(language, theme);
			const text = TEXT[language];
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator(".omp-composer-input").first();
				const scroller = page.locator(".omp-transcript-scroll").first();

				// A transcript taller than the window.
				for (let turn = 0; turn < 3; turn++) {
					await input.fill("fixture markdown");
					await input.press("Enter");
					await expect(page.locator(".omp-transcript-content .markdown-body")).toHaveCount(turn + 1, {
						timeout: 30_000,
					});
				}
				await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(400);

				// ⌃J inserts a newline at the caret; ⌃U deletes back to the line start.
				await input.click();
				await page.keyboard.type("first");
				await page.keyboard.press("Control+j");
				await page.keyboard.type("second line");
				await expect(input).toHaveValue("first\nsecond line");
				await page.keyboard.press("Control+u");
				await expect(input).toHaveValue("first\n");
				await page.keyboard.type("draft to clear");

				// Esc on a selection only collapses it.
				await page.keyboard.press("Shift+Home");
				await page.keyboard.press("Escape");
				await expect(input).toHaveValue("first\ndraft to clear");
				await expect(page.locator("[data-esc-hint]")).toHaveCount(0);

				// Esc twice clears the draft; the first press says so; ↑ brings it back.
				await page.keyboard.press("Escape");
				await expect(page.locator("[data-esc-hint]")).toHaveText(text.escHint);
				await capture(page, `${language}-${theme}-esc-hint`);
				await page.keyboard.press("Escape");
				await expect(input).toHaveValue("");
				await expect(page.locator("[data-esc-hint]")).toHaveCount(0);
				await page.keyboard.press("ArrowUp");
				await expect(input).toHaveValue("first\ndraft to clear");
				await input.fill("");

				// Double Esc on an empty composer: stock's default doubleEscapeAction (rewind picker).
				await input.focus();
				await page.keyboard.press("Escape");
				await page.keyboard.press("Escape");
				const rewind = page.getByRole("dialog", { name: text.rewind });
				await expect(rewind).toBeVisible();
				await capture(page, `${language}-${theme}-rewind`);
				await page.keyboard.press("Escape");
				await expect(rewind).toHaveCount(0);

				// A key typed on the focused transcript lands in the composer.
				await scroller.focus();
				await page.keyboard.type("hi");
				await expect(input).toBeFocused();
				await expect(input).toHaveValue("hi");
				await input.fill("");

				// PageUp in the composer pages the transcript.
				await scroller.evaluate(el => el.scrollTo({ top: el.scrollHeight }));
				const bottom = await scroller.evaluate(el => el.scrollTop);
				await input.focus();
				await page.keyboard.press("PageUp");
				await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeLessThan(bottom - 200);
				await expect(input).toBeFocused();
				await capture(page, `${language}-${theme}-paged`);

				// Context popover: Compact now runs stock compact; Hand off opens the dialog.
				const trigger = page.locator(".omp-context-usage-trigger").first();
				await trigger.click();
				const popover = page.locator("#omp-context-usage-popover");
				await expect(popover.getByRole("button", { name: text.compact })).toBeEnabled();
				await expect(popover.getByRole("button", { name: text.handoff })).toBeEnabled();
				await capture(page, `${language}-${theme}-context-actions`);
				await popover.getByRole("button", { name: text.compact }).click();
				await expect(page.getByText(text.compacted, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
				expect(await recorded(record, "compact")).toBe(1);

				await trigger.click();
				await popover.getByRole("button", { name: text.handoff }).click();
				const handoff = page.getByRole("dialog");
				await expect(handoff).toBeVisible();
				await expect(popover).toHaveCount(0);
				await capture(page, `${language}-${theme}-handoff`);
				await page.keyboard.press("Escape");
				await expect(handoff).toHaveCount(0);

				if (language === "en" && theme === "dark") {
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
					await input.fill("narrow draft");
					await input.press("Escape");
					await expect(page.locator("[data-esc-hint]")).toBeVisible();
					await capture(page, "narrow-en-dark-esc-hint");
					await trigger.click();
					await expect(popover.getByRole("button", { name: text.compact })).toBeVisible();
					await capture(page, "narrow-en-dark-context-actions");
				}
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
