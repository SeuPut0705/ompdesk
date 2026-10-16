/**
 * A turn stopped by the provider's usage limit, on the fake omp. The error
 * card names when the limit resets (the bridge's stock `usageResetAtMs` per
 * account) and books the turn to resume then; Cancel drops the booking, and a
 * kept booking runs stock `retry` at the reset, so the turn answers without a
 * click. Captures: light/dark × en/ko and a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { capture, exitApp, launchApp } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

/** How long after the stop the fixture's limit resets. */
const RESET_MS = 12_000;

const TEXT = {
	en: {
		title: "Usage limit reached",
		resetsAt: "The limit resets at",
		booked: "Resumes on its own at",
		cancel: "Cancel resume",
		started: "The usage limit reset, so the stopped turn runs again.",
	},
	ko: {
		title: "사용 한도 도달",
		resetsAt: "한도가 초기화돼요",
		booked: "자동으로 이어서 해요",
		cancel: "자동 재개 취소",
		started: "사용 한도가 초기화돼서 멈춘 턴을 다시 실행해요.",
	},
} as const;

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-usage-resume-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_USAGE_RESET_MS: String(RESET_MS),
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

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`usage limit names its reset and resumes the turn then (${language} ${theme})`, async () => {
			test.setTimeout(120_000);
			const { app, page, profile } = await launch(language, theme);
			const text = TEXT[language];
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				if (language === "en" && theme === "dark")
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
				const input = page.locator(".omp-composer-input").first();
				await input.fill("fixture usage limit");
				await input.press("Enter");

				const card = page.locator(".omp-message-error").filter({ hasText: text.title });
				await expect(card).toBeVisible({ timeout: 30_000 });
				await expect(card.locator("[data-quota-reset]")).toContainText(text.resetsAt);
				await capture(page, `${language === "en" && theme === "dark" ? "narrow-" : ""}${language}-${theme}-reset`);

				// Book, cancel, book again: the booking is what resumes the turn.
				await card.locator('[data-quota-resume="offer"]').click();
				await expect(card.locator("[data-quota-reset]")).toContainText(text.booked);
				await expect(card.getByRole("button", { name: text.cancel })).toBeVisible();
				await card.getByRole("button", { name: text.cancel }).click();
				await expect(card.locator('[data-quota-resume="offer"]')).toBeVisible();
				await card.locator('[data-quota-resume="offer"]').click();
				await expect(card.locator('[data-quota-resume="booked"]')).toBeVisible();
				await capture(page, `${language === "en" && theme === "dark" ? "narrow-" : ""}${language}-${theme}-booked`);

				// At the reset, stock retry runs the turn again with no click.
				await expect(page.getByText("Resumed after the usage limit reset.")).toBeVisible({
					timeout: RESET_MS + 20_000,
				});
				await expect(page.getByText(text.started)).toBeVisible();
				await capture(
					page,
					`${language === "en" && theme === "dark" ? "narrow-" : ""}${language}-${theme}-resumed`,
				);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
