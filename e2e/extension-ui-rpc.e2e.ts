/**
 * Extension UI and stock RPC paths an rpc-ui host owes the user (stock omp
 * 18.10.3). The fake omp sends several requests at once: status texts, a
 * widget under the editor, a window title, an error notice, a prompt-style
 * editor and two confirms (the last one timed). The card answers one at a
 * time with a "+N waiting" badge; the editor takes Enter; the confirm has a
 * visible Cancel; the queued confirm counts down from its arrival; the status
 * line and the widget sit under the input box; the error notice stays. Then
 * the terminal-only slash commands never reach the model, /open says there is
 * no link, slow mode toggles through `set_slow_mode`, a running `!` bash stops
 * from its card through `abort_bash`, and a running subagent takes a steer
 * through `steer_subagent`. Captures: light/dark × en/ko, plus a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { capture, exitApp, launchApp, openSidebarFamily, readRecords, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT: Record<
	Language,
	{
		waiting: (count: number) => string;
		cancel: string;
		noLink: string;
		collab: string;
		slow: string;
		cancelExec: string;
		steerSent: string;
		steerPlaceholder: string;
	}
> = {
	en: {
		waiting: count => `+${count} waiting`,
		cancel: "Cancel",
		noLink: "No link to open.",
		collab: "works only in the omp terminal app",
		slow: "Slow mode",
		cancelExec: "Cancel",
		steerSent: "Sent to",
		steerPlaceholder: "Add an instruction…",
	},
	ko: {
		waiting: count => `+${count}개 대기 중`,
		cancel: "취소",
		noLink: "열 링크가 없어요.",
		collab: "omp 터미널 앱에서만 쓸 수 있어요",
		slow: "느린 모드",
		cancelExec: "취소",
		steerSent: "보냈어요",
		steerPlaceholder: "추가 지시 입력…",
	},
};

async function launch(
	language: Language,
	theme: Theme,
): Promise<{ app: ElectronApplication; page: Page; profile: string; record: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-ext-ui-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const record = path.join(profile, "commands.jsonl");
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
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_SLOW_MODE: "1",
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

/** Run a fake-omp `fixture:*` command on the focused tab's omp. */
async function fixture(page: Page, line: string): Promise<void> {
	const response = await page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), line);
	expect(response.success).toBe(true);
}

async function submit(page: Page, text: string): Promise<void> {
	const composer = page.locator(".omp-composer-input");
	await composer.fill(text);
	await composer.press("Enter");
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`extension UI and stock RPC paths (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const text = TEXT[language];
			const { app, page, profile, record } = await launch(language, theme);
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			try {
				// ── Several requests at once ───────────────────────────────────
				await fixture(page, "fixture:ext-ui");
				const card = page.locator(".omp-ask-dock [data-prompt-card]");
				await expect(card).toHaveCount(1);
				await expect(card).toContainText("Goal objective");
				await expect(card.locator("[data-prompt-waiting]")).toHaveText(text.waiting(2));
				const status = page.locator(".omp-below-editor-dock [data-extension-status]");
				await expect(status).toHaveText("Indexer ready·✓ 128 tests");
				await expect(page.locator(".omp-below-editor-dock")).toContainText("2 files changed since the last review");
				await expect(page.getByText("Fixture index failed to refresh")).toBeVisible();
				await expect.poll(() => page.title()).toContain("Fixture extension title");
				await capture(page, `ext-editor-${language}-${theme}`);

				// Prompt-style editor: Enter submits.
				const editor = card.locator("textarea");
				await editor.fill("ship it");
				await editor.press("Enter");
				await expect(card).toContainText("Deploy to staging?");
				await expect(card.locator("[data-prompt-waiting]")).toHaveText(text.waiting(1));
				const cancel = card.getByRole("button", { name: text.cancel, exact: true });
				await expect(cancel).toBeVisible();
				await capture(page, `ext-confirm-${language}-${theme}`);
				await cancel.click();

				// The queued, timed confirm: no badge left, countdown visible.
				await expect(card).toContainText("Notify the team?");
				await expect(card.locator("[data-prompt-waiting]")).toHaveCount(0);
				await expect(card.locator("[data-prompt-countdown]")).toBeVisible();
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
				await expect(status).toBeVisible();
				await capture(page, `ext-countdown-narrow-${language}-${theme}`);
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
				await card.press("1");
				await expect(card).toHaveCount(0);
				// The error notice waits for its dismissal.
				await expect(page.getByText("Fixture index failed to refresh")).toBeVisible();
				// A page that loads after they were set gets the statuses, the widget and the title back from main: no frame
				// repeats them (nightly 39539556435: a status sent before the page's listener existed was lost for good).
				await page.reload();
				await page.waitForFunction(() => window.omp?.rpc != null);
				await expect(status).toHaveText("Indexer ready·✓ 128 tests");
				await expect(page.locator(".omp-below-editor-dock")).toContainText("2 files changed since the last review");
				await expect.poll(() => page.title()).toContain("Fixture extension title");

				const responses = (await readRecords(record)).filter(frame => frame.type === "extension_ui_response");
				expect(responses).toEqual([
					expect.objectContaining({ id: "ext-editor", value: "ship it" }),
					expect.objectContaining({ id: "ext-confirm-1", cancelled: true }),
					expect.objectContaining({ id: "ext-confirm-2", confirmed: true }),
				]);

				// ── Terminal-only slash commands never reach the model ─────────
				for (const command of ["/collab start", "/join https://relay.example/s/1", "/leave", "/record"]) {
					await submit(page, command);
				}
				await expect(page.getByText(text.collab).first()).toBeVisible();
				await capture(page, `slash-terminal-only-${language}-${theme}`);
				// With an argument the completion menu is closed, so Enter submits (stock accepts `link`).
				await submit(page, "/open link");
				await expect(page.getByText(text.noLink)).toBeVisible();
				const prompts = (await readRecords(record)).filter(frame => frame.type === "prompt");
				expect(prompts).toEqual([]);

				// ── Slow mode through set_slow_mode ──────────────────────────────
				await page.locator("[data-run-settings-trigger]").click();
				// SwitchField puts its data attribute on the switch, named by the field's label.
				const slow = page.getByRole("switch", { name: text.slow });
				await expect(page.locator("[data-slow-mode]")).toBeVisible();
				await slow.click();
				await expect(slow).toBeChecked();
				await capture(page, `slow-mode-${language}-${theme}`);
				await page.keyboard.press("Escape");
				expect((await readRecords(record)).filter(frame => frame.type === "set_slow_mode")).toEqual([
					expect.objectContaining({ enabled: true }),
				]);

				// ── A running `!` bash stops from its card ───────────────────────
				await submit(page, "!fixture:hold-bash");
				const exec = page.locator(".omp-execution-turn").last();
				await expect(exec).toContainText("fixture:hold-bash");
				await capture(page, `bash-running-${language}-${theme}`);
				await exec.getByRole("button", { name: text.cancelExec, exact: true }).click();
				await expect
					.poll(async () => (await readRecords(record)).some(frame => frame.type === "abort_bash"))
					.toBe(true);
				await expect(page.locator(".omp-execution-turn")).toHaveCount(0);

				// ── Steer a running subagent from its sheet ─────────────────────
				await fixture(page, "fixture:subagents");
				// The session row's key moves to its file once a turn wrote one; there is a single session here.
				await openSidebarFamily(page);
				await page.locator('[data-sidebar-subagent="sa-explore"] button').first().click();
				const steer = page.locator("[data-subagent-steer]");
				await expect(steer).toBeVisible();
				await steer.getByPlaceholder(text.steerPlaceholder).fill("Check the keyboard settings too");
				await capture(page, `subagent-steer-${language}-${theme}`);
				await steer.locator("textarea").press("Enter");
				await expect(page.getByText(text.steerSent).first()).toBeVisible();
				expect((await readRecords(record)).filter(frame => frame.type === "steer_subagent")).toEqual([
					expect.objectContaining({ subagentId: "sa-explore", message: "Check the keyboard settings too" }),
				]);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true });
			}
		});
