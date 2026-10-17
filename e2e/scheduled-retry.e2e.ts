/**
 * A turn that ends in a transient error once stock's own retries are spent is retried by main on a
 * backoff (30 s, 2 min, 10 min; src/main/turn-resume.ts), on the fake omp. The fake answers
 * `fixture network error` with a dropped connection stock gave up on. `OMP_GUI_RETRY_DELAYS_MS`
 * replaces the waits: a long one so the countdown card can be read and cancelled, a short one so
 * the retry fires inside the test. "Retry now" is the card's own Try again (it sends the last prompt
 * again, which the fake fails the same way), so it answers with a fresh error card and a new chain.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { capture, exitApp, fixtureOmp, variants } from "./harness";

type Language = "en" | "ko";

const TEXT = {
	en: { countdown: /Retrying in 0:\d\d…/, attempt: "Attempt 1 of 3", now: "Retry now", cancel: "Cancel" },
	ko: { countdown: /0:\d\d 뒤에 다시 시도해요…/, attempt: "3번 중 1번째", now: "지금 다시 시도", cancel: "취소" },
} as const;

interface Profile {
	root: string;
	desktop: string;
	env: Record<string, string>;
}

async function makeProfile(language: Language, delays: string): Promise<Profile> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sretry-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: "light", firstRunComplete: true, lastProject: project }),
	);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(root),
		OMP_GUI_TEST_SESSION_FILES: "1",
		OMP_GUI_RETRY_DELAYS_MS: delays,
	});
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	return { root, desktop, env };
}

async function launch(profile: Profile): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), `--user-data-dir=${profile.desktop}`],
		env: profile.env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page };
}

/** Stock's own switch for retrying: the schedule only runs while it reads on. */
async function stockRetry(page: Page, enabled: boolean): Promise<void> {
	const response = await page.evaluate(next => window.omp.rpc.setSetting("retry.enabled", next), enabled);
	expect(response.success).toBe(true);
}

/** Send the prompt the fake omp fails with a dropped connection; resolves once the `nth` error card shows. */
async function failTurn(page: Page, nth = 1): Promise<void> {
	const input = page.locator(".omp-composer-input").first();
	await input.fill("fixture network error");
	await input.press("Enter");
	await expect(page.locator(".omp-message-error")).toHaveCount(nth, { timeout: 30_000 });
}

async function cleanup(profile: Profile): Promise<void> {
	await fs.rm(profile.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

for (const language of variants(["en", "ko"] as const))
	test(`a transient failure counts down to a retry that can be cancelled (${language})`, async () => {
		test.setTimeout(120_000);
		const profile = await makeProfile(language, "55000,55000,55000");
		const text = TEXT[language];
		let current: ElectronApplication | undefined;
		try {
			const { app, page } = await launch(profile);
			current = app;
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			await stockRetry(page, true);
			await failTurn(page);

			const scheduled = page.locator("[data-scheduled-retry]");
			await expect(scheduled).toBeVisible({ timeout: 30_000 });
			await expect(scheduled).toContainText(text.countdown);
			await expect(scheduled).toContainText(text.attempt);
			const card = page.locator(".omp-message-error");
			await expect(card.getByRole("button", { name: text.now })).toBeVisible();
			await expect(card.getByRole("button", { name: text.cancel })).toBeVisible();
			await capture(page, `${language}-countdown`);

			await card.getByRole("button", { name: text.cancel }).click();
			await expect(page.locator("[data-scheduled-retry]")).toHaveCount(0);
			await expect(page.locator(".omp-message-error")).toBeVisible();
			expect(errors).toEqual([]);
		} finally {
			if (current) await exitApp(current);
			await cleanup(profile);
		}
	});

test("the retry fires on its own and the turn recovers", async () => {
	test.setTimeout(120_000);
	const profile = await makeProfile("en", "4000,4000,4000");
	let current: ElectronApplication | undefined;
	try {
		const { app, page } = await launch(profile);
		current = app;
		await stockRetry(page, true);
		await failTurn(page);
		await expect(page.locator("[data-scheduled-retry]")).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText("Back online: the turn went on.")).toBeVisible({ timeout: 60_000 });
		await expect(page.locator("[data-scheduled-retry]")).toHaveCount(0);
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});

test("Retry now runs the turn at once, drops the schedule and starts a fresh chain", async () => {
	test.setTimeout(120_000);
	const profile = await makeProfile("en", "90000,90000,90000");
	let current: ElectronApplication | undefined;
	try {
		const { app, page } = await launch(profile);
		current = app;
		await stockRetry(page, true);
		await failTurn(page);
		await expect(page.locator("[data-scheduled-retry]")).toBeVisible({ timeout: 30_000 });
		await page.locator(".omp-message-error").getByRole("button", { name: "Retry now" }).click();
		// The prompt went again and failed again: a second card, and only the latest counts down, from attempt 1.
		await expect(page.locator(".omp-message-error")).toHaveCount(2, { timeout: 30_000 });
		await expect(page.locator("[data-scheduled-retry]")).toHaveCount(1, { timeout: 30_000 });
		await expect(page.locator("[data-scheduled-retry]")).toContainText("Attempt 1 of 3");
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});

test("nothing is scheduled while stock's retry is unreadable or off, or OMPdesk's setting is off", async () => {
	test.setTimeout(120_000);
	// Short waits: a schedule that wrongly existed would fire (and answer) inside the 4 s the test lets pass.
	const profile = await makeProfile("en", "1500,1500,1500");
	let current: ElectronApplication | undefined;
	try {
		const { app, page } = await launch(profile);
		current = app;
		// The fake omp has no `retry.enabled` until it is written: unreadable means the user's choice stands.
		await failTurn(page, 1);
		await page.waitForTimeout(4000);
		await expect(page.locator("[data-scheduled-retry]")).toHaveCount(0);
		await expect(page.getByText("Back online: the turn went on.")).toHaveCount(0);

		// Stock's own switch off.
		await stockRetry(page, false);
		await failTurn(page, 2);
		await page.waitForTimeout(4000);
		await expect(page.locator("[data-scheduled-retry]")).toHaveCount(0);

		// Stock on, OMPdesk's setting off.
		await stockRetry(page, true);
		await page.evaluate(() => window.omp.prefs.set("scheduledRetry", false));
		await failTurn(page, 3);
		await page.waitForTimeout(4000);
		await expect(page.locator("[data-scheduled-retry]")).toHaveCount(0);
		await expect(page.getByText("Back online: the turn went on.")).toHaveCount(0);
	} finally {
		if (current) await exitApp(current);
		await cleanup(profile);
	}
});
