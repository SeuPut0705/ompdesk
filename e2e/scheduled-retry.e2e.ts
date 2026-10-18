/**
 * A turn that ends in a transient error once stock's own retries are spent is retried by main on a
 * backoff (30 s, 2 min, 10 min; src/main/turn-resume.ts), on the fake omp. The fake answers
 * `fixture network error` with a dropped connection stock gave up on; `OMP_GUI_RETRY_DELAYS_MS` shortens
 * the waits so the retry fires inside the test and the turn recovers. The countdown card, Cancel, Retry now
 * and the cases that schedule nothing are unit-tested (TurnErrorNotice.test.tsx, turn-resume.test.ts).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

type Language = "en" | "ko";

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
		args: [path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"), `--user-data-dir=${profile.desktop}`],
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
