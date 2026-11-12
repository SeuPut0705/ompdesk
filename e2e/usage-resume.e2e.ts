/**
 * A turn stopped by the provider's usage limit, on the fake omp. Main waits for the limit by itself (turn-resume.ts):
 * the error card says when the turn is tried again, with Retry now and Cancel and no booking to click, and at that
 * time stock `retry` runs, so the turn answers with no click. A limit that lifts before its time (a reset pass, here
 * the fixture's usage report) is picked up at the next look, and nothing is sent to the provider while it holds.
 * The rules (what is waited for, every call-off, the marker, a hosted tab) are unit-tested in
 * `src/main/turn-resume-limit.test.ts`; a hosted tab on two apps in `remote-resume.e2e.ts`. Captures: light/dark ×
 * en/ko and a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { capture, exitApp, launchApp, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

/** How long after the stop the fixture's limit resets. */
const RESET_MS = 12_000;

const TEXT = {
	en: { title: "Usage limit reached", waits: "Tries again by itself at", cancel: "Cancel", now: "Retry now" },
	ko: { title: "사용 한도 도달", waits: "에 스스로 다시 시도해요", cancel: "취소", now: "지금 다시 시도" },
} as const;

async function launch(
	language: Language,
	theme: Theme,
	env: Record<string, string>,
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
	// A wait is armed for a session with a file (stock writes one at the first reply): the fake writes it only on request.
	const app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_TEST_SESSION_FILES: "1", ...env } });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	// Stock's own switch for retrying: main waits for a limit only while it reads on.
	expect((await page.evaluate(() => window.omp.rpc.setSetting("retry.enabled", true))).success).toBe(true);
	return { app, page, profile };
}

async function send(page: Page, prompt: string): Promise<void> {
	const input = page.locator(".omp-composer-input").first();
	await input.fill(prompt);
	await input.press("Enter");
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`a usage limit says when the turn is tried again and resumes it then, with no click (${language} ${theme})`, async () => {
			test.setTimeout(120_000);
			const { app, page, profile } = await launch(language, theme, {
				OMP_GUI_TEST_USAGE_RESET_MS: String(RESET_MS),
			});
			const text = TEXT[language];
			const shot = (name: string) =>
				capture(page, `${language === "en" && theme === "dark" ? "narrow-" : ""}${language}-${theme}-${name}`);
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				if (language === "en" && theme === "dark")
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
				await send(page, "fixture usage limit");

				// The error names no wait: the provider's usage report says when the account resets.
				const card = page.locator(".omp-message-error").filter({ hasText: text.title });
				await expect(card).toBeVisible({ timeout: 30_000 });
				await expect(card.locator("[data-limit-wait]")).toContainText(text.waits, { timeout: 30_000 });
				await expect(card.getByRole("button", { name: text.now })).toBeVisible();
				await expect(card.getByRole("button", { name: text.cancel })).toBeVisible();
				await expect(card.locator("[data-quota-resume]")).toHaveCount(0);
				await shot("waiting");

				// At the reset, stock retry runs the turn again with no click.
				await expect(page.getByText("Resumed after the usage limit reset.")).toBeVisible({
					timeout: RESET_MS + 30_000,
				});
				await expect(page.locator("[data-limit-wait]")).toHaveCount(0);
				await shot("resumed");
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

test("a limit that lifts before its time is picked up at the next look, and nothing is sent while it holds", async () => {
	test.setTimeout(120_000);
	// The provider names an hour; the account's usage report frees it after eight seconds (a reset pass), and main
	// looks every second and a half. The fixture refuses a retry sent while the account is limited with a second error.
	const { app, page, profile } = await launch("en", "light", {
		OMP_GUI_TEST_RETRY_AFTER_MS: "3600000",
		OMP_GUI_TEST_USAGE_RESET_MS: "8000",
		OMP_GUI_LIMIT_LOOK_MS: "1500",
	});
	try {
		await send(page, "fixture rate limit");
		const wait = page.locator("[data-limit-wait]");
		await expect(wait).toContainText("Tries again by itself at", { timeout: 30_000 });
		// The wait is the hour the provider named, in hours and minutes.
		await expect(wait).toContainText(/in (59m|1h 0m)/);
		await expect(page.getByText("Resumed after the usage limit reset.")).toBeVisible({ timeout: 60_000 });
		await expect(page.locator("[data-turn-retried]")).toHaveCount(1);
		await expect(page.locator(".omp-message-error")).toHaveCount(0);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("Cancel on the card calls the wait off: the failure stays and nothing is tried", async () => {
	test.setTimeout(120_000);
	const { app, page, profile } = await launch("en", "light", {
		OMP_GUI_TEST_RETRY_AFTER_MS: "5000",
		OMP_GUI_TEST_USAGE_RESET_MS: "5000",
	});
	try {
		await send(page, "fixture rate limit");
		await expect(page.locator("[data-limit-wait]")).toBeVisible({ timeout: 30_000 });
		await page.locator("[data-scheduled-retry-cancel]").click();
		await expect(page.locator("[data-limit-wait]")).toHaveCount(0);
		// Past the time the provider named: the card still stands, with its own Try again, and no turn ran.
		await expect(page.locator(".omp-message-error").getByRole("button", { name: "Try again" })).toBeVisible();
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.tabs.list()))[0]?.scheduledRetry ?? null, {
				timeout: 10_000,
			})
			.toBeNull();
		await page.waitForFunction(at => Date.now() > at, Date.now() + 7_000, { timeout: 20_000 });
		await expect(page.getByText("Resumed after the usage limit reset.")).toHaveCount(0);
		await expect(page.locator(".omp-message-error")).toHaveCount(1);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
