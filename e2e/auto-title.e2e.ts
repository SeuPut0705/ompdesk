/**
 * Automatic session titles on the fake omp (e2e/fixture/rpc-ui.ts serves the bridge's `auto_title_set` and
 * `regenerate_title` and names the session "Auto N: <prompt>" the way resources/gui-bridge/modes/auto-title.ts does;
 * the real bridge logic against stock is covered by src/main/bridge-auto-title*.test.ts). Covers: the first
 * prompt names the session, a typed name is never replaced (not by later turns), the editor's auto button names it
 * again and makes it automatic so it follows the work from then on, typing stops that again, a failed request is
 * one inline sentence (never a toast), and the Settings switch is live. A paired host's tab doing the work on the
 * host is covered by the remote command routing tests in main.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp, launchApp, pressShortcutUntilVisible, recordsOfType } from "./harness";

interface Launched {
	app: ElectronApplication;
	page: Page;
	profile: string;
	record: string;
}

let launches = 0;

async function launch(
	options: { prefs?: Record<string, unknown>; script?: Record<string, unknown> } = {},
): Promise<Launched> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-auto-title-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const record = path.join(profile, `commands-${++launches}.jsonl`);
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", themeName: "light", firstRunComplete: true, ...options.prefs }),
	);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_AUTO_TITLE: JSON.stringify(options.script ?? {}),
			// An omp session running the suite exports it; the app under test reads the user's own environment.
			PI_NO_TITLE: undefined,
		},
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, record };
}

async function finish(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function composer(page: Page): Locator {
	return page.locator(".omp-composer-input").first();
}

/** One finished turn: the fixture answers every prompt with "Local fixture reply". */
async function runTurn(page: Page, replies: number, message = "hello there"): Promise<void> {
	const input = composer(page);
	await input.fill(message);
	await input.press("Enter");
	await expect(page.getByText("Local fixture reply")).toHaveCount(replies, { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

const titleButton = (page: Page) => page.locator("[data-titlebar-session-name]");
const renameField = (page: Page) => page.locator(".omp-titlebar-identity input");
const autoButton = (page: Page) => page.locator(".omp-titlebar-identity [data-auto-title]");

async function typeTitle(page: Page, name: string): Promise<void> {
	await titleButton(page).click();
	await renameField(page).fill(name);
	await renameField(page).press("Enter");
	await expect(titleButton(page)).toHaveText(name);
}

test("names the session from the first prompt, keeps a typed name, and the auto button makes it automatic again", async () => {
	const launched = await launch();
	const { page, record } = launched;
	try {
		await runTurn(page, 1);
		// First prompt: the title appears by itself, in the title bar and the sidebar.
		await expect(titleButton(page)).toHaveText("Auto 1: hello there");
		await expect(page.locator(".omp-session-sidebar")).toContainText("Auto 1: hello there");
		expect((await recordsOfType(record, "auto_title_set")).at(0)).toMatchObject({ enabled: true, evolve: true });

		// A typed name is the person's own: the work that follows never replaces it.
		await typeTitle(page, "My own name");
		expect(await recordsOfType(record, "set_session_name")).toMatchObject([{ name: "My own name" }]);
		await runTurn(page, 2);
		await runTurn(page, 3);
		await runTurn(page, 4);
		await expect(titleButton(page)).toHaveText("My own name");

		// The editor's auto button names it again, saves it, and closes the editor.
		await titleButton(page).click();
		await expect(autoButton(page)).toBeVisible();
		await expect(autoButton(page)).toHaveAccessibleName("Generate title automatically");
		await autoButton(page).click();
		await expect(titleButton(page)).toHaveText("Auto 2: hello there");
		await expect(renameField(page)).toHaveCount(0);
		expect(await recordsOfType(record, "regenerate_title")).toHaveLength(1);
		// The omp saved it: the editor sent no typed name over it.
		expect(await recordsOfType(record, "set_session_name")).toHaveLength(1);

		// Automatic again, so it follows the work: two finished turns later it moves on.
		await runTurn(page, 5);
		await runTurn(page, 6);
		await expect(titleButton(page)).toHaveText("Auto 3: hello there");

		// Typing stops that again.
		await typeTitle(page, "Final name");
		await runTurn(page, 7);
		await runTurn(page, 8);
		await runTurn(page, 9);
		await expect(titleButton(page)).toHaveText("Final name");
		expect(await recordsOfType(record, "regenerate_title")).toHaveLength(1);
	} finally {
		await finish(launched);
	}
});

test("a failed regeneration is one inline sentence under the field, never a toast", async () => {
	const launched = await launch({ script: { fail: true } });
	const { page } = launched;
	try {
		await runTurn(page, 1);
		await expect(titleButton(page)).toHaveText("Auto 1: hello there");
		await titleButton(page).click();
		await autoButton(page).click();
		const alert = page.locator("[data-auto-title-error]");
		await expect(alert).toHaveText("Couldn't generate a title. Try again.");
		await expect(alert).toHaveAttribute("role", "alert");
		// The editor stays, the title is untouched, and no toast piled up.
		await expect(renameField(page)).toBeVisible();
		// The inline sentence is the only alert on the page: an error toast would be a second one.
		await expect(page.getByRole("alert")).toHaveCount(1);
		await renameField(page).press("Escape");
		await expect(titleButton(page)).toHaveText("Auto 1: hello there");
	} finally {
		await finish(launched);
	}
});

test("the Settings switch is live: off keeps the session untitled, on names it from the next prompt", async () => {
	const launched = await launch({ prefs: { autoTitle: false } });
	const { page, record } = launched;
	try {
		await runTurn(page, 1);
		await expect(titleButton(page)).not.toHaveText(/^Auto /);
		expect((await recordsOfType(record, "auto_title_set")).at(0)).toMatchObject({ enabled: false });

		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="agent"]').click();
		const autoTitleSwitch = settings.locator("#setting-gui-autoTitle").getByRole("switch");
		const evolveSwitch = settings.locator("#setting-gui-autoTitleEvolve").getByRole("switch");
		await expect(autoTitleSwitch).not.toBeChecked();
		await expect(evolveSwitch).toBeDisabled();
		await autoTitleSwitch.click();
		await expect(autoTitleSwitch).toBeChecked();
		await expect(evolveSwitch).toBeEnabled();
		await expect
			.poll(async () => (await recordsOfType(record, "auto_title_set")).at(-1))
			.toMatchObject({ enabled: true, evolve: true });
		await page.keyboard.press("Escape");
		await expect(page.locator("[data-settings-page]")).toHaveCount(0);

		await runTurn(page, 2, "second prompt");
		await expect(titleButton(page)).toHaveText("Auto 1: second prompt");
	} finally {
		await finish(launched);
	}
});
