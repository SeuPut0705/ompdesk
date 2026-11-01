/**
 * Automatic session titles on the fake omp (e2e/fixture/rpc-ui.ts serves the bridge's `auto_title_set` and
 * `regenerate_title` and names the session "Auto N: <prompt>" the way resources/gui-bridge/modes/auto-title.ts does;
 * the real bridge logic against stock is covered by src/main/bridge-auto-title*.test.ts). Covers: the first prompt
 * names the session; a typed name stays the person's while automatic titles go on beside it (`<name> · <automatic>`
 * in the title bar and the sidebar row); the editor's auto button names it again and makes it automatic, alone. A
 * failed request (TitleBar.test.tsx) and the live Settings switch (AutoTitleRow.test.tsx, bridge-auto-title.test.ts)
 * are component-tested; a paired host's session is e2e/session-rename-title.e2e.ts.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp, launchApp, recordsOfType } from "./harness";

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
const titleName = (page: Page) => titleButton(page).locator("[data-title-name]");
const titleAuto = (page: Page) => titleButton(page).locator("[data-title-auto]");
const renameField = (page: Page) => page.locator(".omp-titlebar-identity input");
const autoButton = (page: Page) => page.locator(".omp-titlebar-identity [data-auto-title]");
const sidebarRow = (page: Page, name: string) =>
	page.locator(".omp-session-sidebar [data-title-name]", { hasText: name }).locator("xpath=..");

async function typeTitle(page: Page, name: string): Promise<void> {
	await titleButton(page).click();
	await renameField(page).fill(name);
	await renameField(page).press("Enter");
	await expect(titleName(page)).toHaveText(name);
}

test("names the session from the first prompt, keeps naming it beside a typed name, and the auto button makes it automatic again", async () => {
	const launched = await launch();
	const { page, record } = launched;
	try {
		await runTurn(page, 1);
		// First prompt: the title appears by itself, in the title bar and the sidebar, alone.
		await expect(titleButton(page)).toHaveText("Auto 1: hello there");
		await expect(titleAuto(page)).toHaveCount(0);
		await expect(page.locator(".omp-session-sidebar")).toContainText("Auto 1: hello there");
		expect((await recordsOfType(record, "auto_title_set")).at(0)).toMatchObject({ enabled: true, evolve: true });

		// A typed name is the person's own and stays; the automatic title it went over shows beside it, muted.
		await typeTitle(page, "My own name");
		expect(await recordsOfType(record, "set_session_name")).toMatchObject([{ name: "My own name" }]);
		await expect(titleAuto(page)).toHaveText("Auto 1: hello there");
		await expect(sidebarRow(page, "My own name").locator("[data-title-auto]")).toHaveText("Auto 1: hello there");
		// The work goes on: the automatic title follows it beside the name, which never changes.
		await runTurn(page, 2);
		await runTurn(page, 3);
		await expect(titleAuto(page)).toHaveText(/^Auto [2-9]: hello there$/);
		await expect(titleName(page)).toHaveText("My own name");
		await expect(sidebarRow(page, "My own name").locator("[data-title-auto]")).toHaveText(
			/^Auto [2-9]: hello there$/,
		);
		expect(await recordsOfType(record, "set_session_name")).toHaveLength(1);

		// The editor's auto button names it again, saves it, and closes the editor: one automatic title, alone.
		await titleButton(page).click();
		await expect(autoButton(page)).toBeVisible();
		await expect(autoButton(page)).toHaveAccessibleName("Generate title automatically");
		await autoButton(page).click();
		await expect(titleButton(page)).toHaveText(/^Auto \d+: hello there$/);
		await expect(titleAuto(page)).toHaveCount(0);
		await expect(renameField(page)).toHaveCount(0);
		expect(await recordsOfType(record, "regenerate_title")).toHaveLength(1);
		// The omp saved it: the editor sent no typed name over it.
		expect(await recordsOfType(record, "set_session_name")).toHaveLength(1);

		// Typing again keeps the name, and the automatic title goes on beside it.
		const before = await titleButton(page).innerText();
		await typeTitle(page, "Final name");
		await expect(titleAuto(page)).toHaveText(before);
		await runTurn(page, 4);
		await runTurn(page, 5);
		await expect(titleAuto(page)).not.toHaveText(before);
		await expect(titleName(page)).toHaveText("Final name");
		expect(await recordsOfType(record, "regenerate_title")).toHaveLength(1);
	} finally {
		await finish(launched);
	}
});
