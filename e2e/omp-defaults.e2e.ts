/**
 * Held omp defaults and the idle recap on the fake omp (e2e/fixture/rpc-ui.ts): the fixture serves the bridge's
 * `recap_draft` and sends the `recap` custom message a real bridge's timer would
 * (`OMP_GUI_TEST_RECAP`, rules pinned in src/main/bridge-session-recap.test.ts and against stock in
 * bridge-session-recap-stock.test.ts), and reports `lsp.diagnosticsOnEdit` as the runtime override
 * OMPdesk holds (resources/gui-bridge/thinking-default-core.ts) until a Settings write releases it.
 * Covers the quiet recap card after a turn (en; ko with OMP_GUI_VARIANTS=1, captured) and Settings showing
 * `Runtime override`, then `Global` after the user's own write. The draft holding the recap back is unit-tested
 * in src/main/bridge-session-recap.test.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { capture, exitApp, launchApp, pressShortcutUntilVisible, variants } from "./harness";

type Language = "en" | "ko";

const RECAP = "You are wiring the recap card. Next: run the checks.";
const TEXT = {
	en: { label: "Recap", runtime: "Runtime override", global: "Global" },
	ko: { label: "요약", runtime: "Runtime override", global: "Global" },
} as const;

interface Launched {
	app: ElectronApplication;
	page: Page;
	profile: string;
	errors: string[];
}

async function launch(language: Language, delayMs: number): Promise<Launched> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-defaults-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: "light", firstRunComplete: true }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_RECAP: JSON.stringify({ text: RECAP, delayMs }),
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, errors };
}

async function finish(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function composer(page: Page): Locator {
	return page.locator(".omp-composer-input").first();
}

/** Send one plain prompt and wait until its reply is in and the run is over. */
async function runTurn(page: Page, replies: number): Promise<void> {
	const input = composer(page);
	await input.fill("hello there");
	await input.press("Enter");
	await expect(page.getByText("Local fixture reply")).toHaveCount(replies, { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

function recapLine(page: Page): Locator {
	return page.locator("[data-recap]");
}

for (const language of variants(["en", "ko"] as const)) {
	test(`${language}: a quiet recap line lands after an idle turn, once, and stays in the transcript`, async () => {
		test.setTimeout(120_000);
		const launched = await launch(language, 400);
		try {
			const { page } = launched;
			await runTurn(page, 1);
			const line = recapLine(page);
			await expect(line).toHaveCount(1, { timeout: 15_000 });
			await expect(line).toContainText(RECAP);
			await expect(line).toContainText(TEXT[language].label);
			// One recap per idle window: nothing more arrives without another turn.
			await page.waitForTimeout(1_500);
			await expect(line).toHaveCount(1);
			await capture(page, `recap-${language}`);
			expect(launched.errors).toEqual([]);
		} finally {
			await finish(launched);
		}
	});
}

test("Settings reports a held default as a runtime override, and the user's own write releases it", async () => {
	test.setTimeout(120_000);
	const launched = await launch("en", 400);
	try {
		const { page } = launched;
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.getByRole("searchbox", { name: "Search settings" }).fill("lsp.diagnosticsOnEdit");
		await settings.getByRole("button", { name: /^Diagnostics on Edit/ }).click();
		const row = settings.locator('[id="setting-lsp.diagnosticsOnEdit"]');
		const toggle = row.getByRole("switch");
		await expect(toggle).toBeChecked();
		const source = row.locator("details summary");
		await expect(source).toContainText(TEXT.en.runtime);
		await capture(page, "settings-runtime");
		await toggle.click();
		await expect(toggle).not.toBeChecked();
		// The write replaced OMPdesk's default: the row now reports the user's own global value.
		await expect(source).toContainText(TEXT.en.global);
		await expect(source).not.toContainText(TEXT.en.runtime);
		expect(launched.errors).toEqual([]);
	} finally {
		await finish(launched);
	}
});
