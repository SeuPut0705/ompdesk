/**
 * Sidebar archive and Settings › Schedules end to end on the fake omp: a saved
 * session no tab holds archives into the folded Archived section and restores;
 * a schedule runs `omp -p` in its project with the prompt on stdin, shows its
 * outcome and log, and a hanging run stops. Captures in light/dark × en/ko,
 * plus a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "playwright";
import { cssString, exitApp, launchApp, pressShortcutUntilVisible, variants } from "./harness";
import { resize } from "./shell-capture";

const TEXT = {
	en: {
		archived: "Archived (1)",
		archive: "Archive",
		restore: "Restore",
		done: "Succeeded",
		stopped: "Stopped",
		newSchedule: "New schedule",
		create: "Create",
	},
	ko: {
		archived: "보관함 (1)",
		archive: "보관",
		restore: "보관 해제",
		done: "성공",
		stopped: "중단됨",
		newSchedule: "새 예약",
		create: "만들기",
	},
} as const;

for (const [language, theme] of variants([
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
] as const)) {
	test(`archive a session and run a schedule (${language} ${theme})`, async () => {
		test.setTimeout(120_000);
		const text = TEXT[language];
		const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-archive-${language}-${theme}-`));
		const desktop = path.join(root, "desktop");
		const project = path.join(root, "project");
		const agent = path.join(root, "agent");
		const record = path.join(root, "rpc.jsonl");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
		const app = await launchApp({
			project,
			desktop,
			agent,
			profile: root,
			env: {
				OMP_GUI_TEST_RECORD: record,
				OMP_GUI_TEST_SESSION_FILES: "1",
			},
		});
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		const shot = (name: string) =>
			page.screenshot({
				path: test.info().outputPath(`archive-${language}-${theme}-${name}.png`),
				scale: "css",
				animations: "disabled",
			});
		try {
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status)
				.toBe("ready");

			// A saved session, then its tab closes so only the stored row is left.
			const composer = page.locator('.omp-session-pane[data-active="true"] textarea');
			await composer.fill("Sketch the archive flow");
			await composer.press("Enter");
			await expect.poll(() => activeTab(page).then(tab => tab.sessionPath ?? "")).toMatch(/\.jsonl$/);
			const saved = await activeTab(page);
			// The tab names its session file before the file exists (it appears with the first entry, once the send is
			// processed) and reads "ready" before the turn starts: a tab closed on either has no stored session to list.
			await expect
				.poll(() => fs.readFile(saved.sessionPath ?? "", "utf8").catch(() => ""))
				.toContain("Sketch the archive flow");
			await expect.poll(() => activeTab(page).then(tab => tab.status)).toBe("ready");
			await page.keyboard.press("ControlOrMeta+t");
			await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(2);
			// The new tab holds a typed command, so leaving it for the saved one does not close it as empty.
			const extra = await activeTab(page);
			await expect
				.poll(
					async () =>
						(await page.evaluate(() => window.omp.tabs.list())).find(t => t.tabId === extra.tabId)?.status,
				)
				.toBe("ready");
			await page.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Scratch" }),
				extra.tabId,
			);
			await expect
				.poll(
					async () =>
						(await page.evaluate(() => window.omp.tabs.list())).find(t => t.tabId === extra.tabId)?.unstarted,
				)
				.toBeFalsy();
			await page.keyboard.press("ControlOrMeta+1");
			await expect.poll(() => activeTab(page).then(tab => tab.tabId)).toBe(saved.tabId);
			await page.keyboard.press("ControlOrMeta+w");
			await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(1);

			const row = page.locator(`.omp-sidebar-session-row[data-session-path=${cssString(saved.sessionPath ?? "")}]`);
			await expect(row).toBeVisible();
			await row.hover();
			await row.locator("[data-sidebar-row-menu]").click();
			await page.getByRole("menuitem", { name: text.archive, exact: true }).click();
			await expect(row).toBeHidden();
			const archived = page.locator("[data-sidebar-archived]");
			await expect(archived).toContainText(text.archived);
			await shot("archived-folded");
			await archived.locator("button[aria-expanded]").click();
			await expect(row).toBeVisible();
			await shot("archived-open");
			await row.hover();
			await row.locator("[data-sidebar-row-menu]").click();
			await page.getByRole("menuitem", { name: text.restore, exact: true }).click();
			await expect(archived).toBeHidden();
			await expect(row).toBeVisible();

			// Settings › Schedules: create, run, read the log; a hanging run stops.
			const settings = page.locator("[data-settings-page]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
			await settings.locator('[data-settings-section="schedules"]').click();
			await expect(settings.getByRole("button", { name: text.newSchedule })).toBeVisible();
			await shot("schedules-empty");
			await createSchedule(page, "Hello run", "fixture hello", text);
			const hello = settings.locator("[data-schedule]").filter({ hasText: "Hello run" });
			await hello.locator("[data-schedule-run]").click();
			const helloRun = settings.locator("[data-schedule-run-row]").filter({ hasText: "Hello run" });
			await expect(helloRun).toContainText(text.done);
			await helloRun.getByRole("button", { expanded: false }).click();
			await expect(helloRun.locator("[data-schedule-log]")).toContainText("fixture print: fixture hello");
			const printed = (await fs.readFile(record, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line))
				.filter(frame => frame.type === "print");
			expect(printed).toEqual([expect.objectContaining({ argv: ["-p"], prompt: "fixture hello" })]);
			expect(await fs.realpath(printed[0].cwd)).toBe(await fs.realpath(project));
			await shot("schedules-run");

			await createSchedule(page, "Hang run", "fixture hang", text);
			const hang = settings.locator("[data-schedule]").filter({ hasText: "Hang run" });
			await hang.locator("[data-schedule-run]").click();
			const stop = hang.getByRole("button", { name: language === "en" ? "Stop" : "중단" });
			await expect(stop).toBeVisible();
			await stop.click();
			await expect(settings.locator("[data-schedule-run-row]").filter({ hasText: "Hang run" })).toContainText(
				text.stopped,
			);

			if (language === "en" && theme === "light") {
				await resize(app, 560, 760);
				await shot("schedules-narrow");
			}
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}

async function activeTab(page: Page) {
	const active = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	return active;
}

/** New schedule in the focused tab's project: every 5 minutes, saved on. */
async function createSchedule(
	page: Page,
	name: string,
	prompt: string,
	text: { newSchedule: string; create: string },
): Promise<void> {
	await page.locator("[data-settings-page]").locator("[data-schedule-new]").first().click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.locator("[data-schedule-form]")).toBeVisible();
	const fields = dialog.locator("input:not([type=number]):not([type=time]), textarea");
	await fields.nth(0).fill(name);
	await dialog.locator("textarea").fill(prompt);
	await expect(dialog.locator("[data-schedule-cwd]")).not.toBeEmpty();
	await dialog.getByRole("button", { name: text.create }).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator("[data-schedule]").filter({ hasText: name })).toBeVisible();
}
