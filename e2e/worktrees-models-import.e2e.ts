/**
 * The Claude/Codex import dialog on the fake omp (fixture `OMP_GUI_TEST_FOREIGN`): it filters by project and
 * time range, Select all picks the shown sessions, the batch shows "Importing n of total" and reports a failed
 * one, and closing mid-import finishes in the background with toasts. Captures: en-light (ko-dark with
 * OMP_GUI_VARIANTS=1) in the test output directory. Agent worktrees and Model overrides are component-tested
 * (AgentWorktreesRow.test.tsx, ModelOverrides.test.tsx) with their main sides (agent-worktrees.test.ts,
 * models-config.test.ts).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { capture, exitApp, fixtureOmp, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: {
		send: "Send",
		importTitle: "Import external session",
		selectAll: (count: number) => `Select all (${count})`,
		importN: (count: number) => `Import ${count}`,
		progress: (done: number, total: number) => `Importing ${done} of ${total}`,
		imported: (count: number) => `Imported ${count} sessions`,
		failedN: (count: number) => `${count} sessions couldn't be imported`,
		done: "Imported",
		background: "Importing continues in the background",
	},
	ko: {
		send: "보내기",
		importTitle: "외부 세션 가져오기",
		selectAll: (count: number) => `모두 선택(${count})`,
		importN: (count: number) => `${count}개 가져오기`,
		progress: (done: number, total: number) => `${total}개 중 ${done}개 가져오는 중`,
		imported: (count: number) => `세션 ${count}개를 가져왔어요`,
		failedN: (count: number) => `세션 ${count}개를 가져오지 못했어요`,
		done: "가져옴",
		background: "가져오기는 백그라운드에서 계속돼요",
	},
} as const;

const RUNS = [
	["en", "light"],
	["ko", "dark"],
] as const satisfies ReadonlyArray<readonly [Language, Theme]>;

interface Launched {
	app: ElectronApplication;
	page: Page;
	desktop: string;
	agent: string;
	errors: string[];
}

let profile: string | null = null;
let launched: Launched | null = null;

test.afterEach(async () => {
	if (launched) await exitApp(launched.app);
	launched = null;
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	profile = null;
});

async function launch(language: Language, theme: Theme, env: Record<string, string> = {}): Promise<Launched> {
	profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-maintenance-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
	);
	const fullEnv = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: await fixtureOmp(profile),
		...env,
	};
	Reflect.deleteProperty(fullEnv, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env: fullEnv,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	launched = { app, page, desktop, agent, errors };
	return launched;
}

for (const [language, theme] of variants(RUNS)) {
	const text = TEXT[language];

	test(`B15: import filters by project and time, imports a batch with progress and finishes in the background (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const { page, errors } = await launch(language, theme, { OMP_GUI_TEST_FOREIGN: "1" });
		const tabId = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
		if (!tabId) throw new Error("No active tab");
		const release = async () => {
			const response = await page.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:release-import" }),
				tabId,
			);
			expect(response).toMatchObject({ success: true });
		};
		const openImport = async () => {
			await page.locator("textarea").first().fill("/import");
			await page.getByRole("button", { name: text.send, exact: true }).click();
			const dialog = page.getByRole("dialog", { name: text.importTitle });
			await expect(dialog).toBeVisible();
			return dialog;
		};
		const row = (dialog: Locator, title: string) => dialog.locator("label").filter({ hasText: title });

		let dialog = await openImport();
		const rows = dialog.locator("label:has(input[type=checkbox]:not([data-import-select-all]))");
		await expect(rows).toHaveCount(4);
		await dialog.locator("select[data-import-project]").selectOption("/work/api");
		await expect(rows).toHaveCount(2);
		await dialog.locator("select[data-import-project]").selectOption("");
		await dialog.locator("select[data-import-range]").selectOption("30");
		await expect(rows).toHaveCount(3);
		await expect(row(dialog, "Migrate to the new router")).toHaveCount(0);

		// Select all (3): the first imports at once, the second is held, the third fails.
		await dialog.getByText(text.selectAll(3), { exact: true }).click();
		await dialog.getByRole("button", { name: text.importN(3), exact: true }).click();
		const progress = dialog.locator("[data-import-progress]");
		await expect(progress).toContainText(text.progress(1, 3));
		await capture(page, `import-progress-${language}-${theme}`);
		await release();
		await expect(progress).toHaveCount(0);
		await expect(page.getByText(text.imported(2), { exact: true })).toBeVisible();
		await expect(dialog).toContainText("The transcript ends mid-line");
		await expect(row(dialog, "Fix the login redirect")).toContainText(text.done);
		await expect(row(dialog, "Speed up the test suite")).toContainText(text.done);
		await expect(row(dialog, "Polish the landing page")).not.toContainText(text.done);
		await capture(page, `import-done-${language}-${theme}`);
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);

		// The batch's toast goes before the next batch reports the same count.
		await expect(page.getByText(text.imported(2), { exact: true })).toHaveCount(0, { timeout: 15_000 });

		// Closed mid-import: the rest finishes in the background and reports by toast.
		dialog = await openImport();
		for (const title of ["Speed up the test suite", "Polish the landing page", "Migrate to the new router"])
			await row(dialog, title).locator("input[type=checkbox]").check();
		await dialog.getByRole("button", { name: text.importN(3), exact: true }).click();
		await expect(dialog.locator("[data-import-progress]")).toContainText(text.progress(0, 3));
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(page.getByText(text.background).first()).toBeVisible();
		await release();
		await expect(page.getByText(text.imported(2), { exact: true })).toBeVisible();
		await expect(page.getByText(text.failedN(1), { exact: true })).toBeVisible();
		await capture(page, `import-background-${language}-${theme}`);
		expect(errors).toEqual([]);
	});
}
