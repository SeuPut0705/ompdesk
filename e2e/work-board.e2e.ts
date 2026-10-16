/**
 * The work board on the fake omp: a wide session pane docks this session's live state in its right
 * margin — the running subagents and the todo list here — and shifts the transcript and composer
 * columns left together. It leaves when the pane gets narrow, when the side panel opens, and in a
 * split whose panes are too narrow for it. Captures in light/dark × en/ko at 1600px and the split.
 * They go to `OMP_GUI_WORK_BOARD_CAPTURES` (default: the test output directory).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: { board: "Work board", closePanel: "Close side panel", hide: "Hide work board", running: "Running" },
	ko: { board: "작업 현황", closePanel: "사이드 패널 닫기", hide: "작업 현황 숨기기", running: "실행 중" },
} as const;

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
}

async function launch(language: Language, theme: Theme): Promise<Launched> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-work-board-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
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
			// Stock-shaped session files: the split drag needs saved sessions.
			OMP_GUI_TEST_SESSION_FILES: "1",
		},
	});
	const page = await app.firstWindow();
	await resize(app, 1600, 900);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, root };
}

const resize = (app: ElectronApplication, width: number, height: number) =>
	app.evaluate(
		({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
		{ width, height },
	);

/** A `bash` line the fake omp reads as a fixture command. */
async function fixture(page: Page, line: string): Promise<void> {
	const response = await page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), line);
	expect(response.success).toBe(true);
}

/**
 * Sends a prompt and waits until the fake omp has run it to its end (main records the run's reply). The composer
 * delivers a prompt a task and a prefs read after Enter, so a fixture command sent once the optimistic row shows can
 * reach omp first; the prompt's turn then ends the fixture's turn and its get_state empties the todos.
 */
async function send(page: Page, text: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(text);
	await input.press("Enter");
	await expect(input).toHaveValue("");
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.lastRun?.reply, {
			timeout: 30_000,
		})
		.toBe("Local fixture reply");
}

async function left(locator: Locator): Promise<number> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("expected a box");
	return Math.round(box.x);
}

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`${language === "en" && theme === "light" ? "@smoke " : ""}the work board docks in a wide pane and steps aside for a narrow one and the side panel (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const text = TEXT[language];
			const { app, page, root } = await launch(language, theme);
			const captures = process.env.OMP_GUI_WORK_BOARD_CAPTURES;
			if (captures) await fs.mkdir(captures, { recursive: true });
			const capture = async (stage: string) => {
				const file = `work-board-${stage}-${language}-${theme}.png`;
				await page.screenshot({
					path: captures ? path.join(captures, file) : test.info().outputPath(file),
					animations: "disabled",
					scale: "css",
				});
			};
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const board = page.getByRole("complementary", { name: text.board });
				const pane = page.locator(".omp-session-pane").first();

				// Nothing to show yet: no board takes the margin.
				await send(page, "hello");
				await expect(page.locator("[data-transcript-kind]").first()).toBeVisible({ timeout: 30_000 });
				await expect(board).toHaveCount(0);
				await expect(pane).not.toHaveAttribute("data-work-board", "");

				// A running subagent and a todo list: the board appears with both.
				await fixture(page, "fixture:subagents");
				await fixture(page, "fixture:todo");
				await expect(board).toBeVisible();
				await expect(pane).toHaveAttribute("data-work-board", "");
				await expect(board.getByRole("heading", { name: text.running })).toBeVisible();
				const explore = board.locator('[data-board-agent="sa-explore"]');
				await expect(explore).toContainText("Map the settings code");
				await expect(board.locator('[data-board-agent="sa-review"]')).toHaveCount(0);
				await expect(board.locator('[data-board-section="todos"]')).toContainText("0/6");
				await expect(board.locator('[data-board-section="todos"]')).toContainText("Fixture task 1");

				// The board sits in the right margin, clear of the columns, which line up with each other.
				const boardBox = await board.boundingBox();
				const shell = page.locator(".omp-composer-shell").first();
				const shellBox = await shell.boundingBox();
				const paneBox = await pane.boundingBox();
				if (!boardBox || !shellBox || !paneBox) throw new Error("expected the board, composer and pane");
				expect(boardBox.x).toBeGreaterThanOrEqual(shellBox.x + shellBox.width);
				expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width);
				expect(boardBox.y).toBeGreaterThanOrEqual(paneBox.y);
				// Columns line up; subpixel rounding of the shifted columns may differ by one pixel.
				expect(
					Math.abs((await left(page.locator(".omp-transcript-row").first())) - (await left(shell))),
				).toBeLessThanOrEqual(1);
				// The dock strips that say what the board says step aside while it shows.
				await expect(page.locator("[data-workspace-island]")).toBeHidden();
				await expect(page.locator('[data-dock-card="todo"]')).toBeHidden();
				await capture("wide");

				// A narrow window has no room: the board goes and the columns centre again.
				await resize(app, 1100, 900);
				await expect(board).toHaveCount(0);
				await expect(pane).not.toHaveAttribute("data-work-board", "");
				await expect(page.locator("[data-workspace-island]")).toBeVisible();
				await expect(page.locator('[data-dock-card="todo"]')).toBeVisible();
				await capture("narrow");
				await resize(app, 1600, 900);
				await expect(board).toBeVisible();

				// Opening a subagent opens the side panel, and the board steps aside for it.
				await explore.click();
				await expect(page.locator("aside[data-docked]")).toBeVisible();
				await expect(board).toHaveCount(0);
				await expect(pane).not.toHaveAttribute("data-work-board", "");
				await expect(page.locator("[data-workspace-island]")).toBeVisible();
				await expect(page.locator('[data-dock-card="todo"]')).toBeVisible();
				await page.getByRole("button", { name: text.closePanel }).click();
				await expect(page.locator("[data-workspace-island]")).toBeHidden();
				await expect(page.locator('[data-dock-card="todo"]')).toBeHidden();
				await expect(board).toBeVisible();

				// The board's own button hides it and keeps it off (the pref).
				await board.getByRole("button", { name: text.hide }).click();
				await expect(board).toHaveCount(0);
				await expect
					.poll(async () => (await page.evaluate(() => window.omp.prefs.get("workBoard"))) === false)
					.toBe(true);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

test("a split's panes are too narrow for the work board", async () => {
	test.setTimeout(240_000);
	const { app, page, root } = await launch("en", "light");
	const captures = process.env.OMP_GUI_WORK_BOARD_CAPTURES;
	if (captures) await fs.mkdir(captures, { recursive: true });
	try {
		const tabId = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
		if (!tabId) throw new Error("No active tab");
		await send(page, "Work on Alpha");
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status)
			.toBe("ready");
		await fixture(page, "fixture:title:Alpha");
		await fixture(page, "fixture:subagents");
		await fixture(page, "fixture:todo");
		const board = page.getByRole("complementary", { name: TEXT.en.board });
		await expect(board).toBeVisible();

		// A second session, dragged onto the right edge: two panes of about half the window each.
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length).toBe(2);
		const second = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId !== tabId);
		if (!second) throw new Error("No second tab");
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === second.tabId)?.status,
			)
			.toBe("ready");
		await send(page, "Work on Beta");
		await expect
			.poll(async () => {
				const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === second.tabId);
				return tab?.sessionPath ?? "";
			})
			.toMatch(/\.jsonl$/);
		await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
			second.tabId,
			"fixture:title:Beta",
		] as const);
		const row = page.locator(".omp-sidebar-session-row", { hasText: "Alpha" });
		await expect(row).toBeVisible();
		const rowBox = await row.boundingBox();
		const workspace = await page.locator(".omp-split-workspace").boundingBox();
		if (!rowBox || !workspace) throw new Error("expected the row and the workspace");
		await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 4 });
		await page.mouse.move(workspace.x + workspace.width * 0.92 + 2, workspace.y + workspace.height / 2, {
			steps: 12,
		});
		await page.mouse.move(workspace.x + workspace.width * 0.92, workspace.y + workspace.height / 2, { steps: 2 });
		await expect(page.locator("[data-split-ghost]")).toHaveAttribute("data-split-ghost", "right");
		await page.mouse.up();
		await expect(page.locator(".omp-session-pane")).toHaveCount(2);

		// Neither pane has the room: no board, and no pane keeps its shift.
		await expect(page.locator("[data-work-board-panel]")).toHaveCount(0);
		await expect(page.locator(".omp-session-pane[data-work-board]")).toHaveCount(0);
		await page.screenshot({
			path: captures
				? path.join(captures, "work-board-split-en-light.png")
				: test.info().outputPath("work-board-split-en-light.png"),
			animations: "disabled",
			scale: "css",
		});
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`the board's sections: waiting first, agents on their models, account, speed, todos, goal, jump key and folds (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const { app, page, root } = await launch(language, theme);
			try {
				await send(page, "hello");
				await expect(page.locator("[data-transcript-kind]").first()).toBeVisible({ timeout: 30_000 });
				await fixture(page, "fixture:board");
				const captures = process.env.OMP_GUI_WORK_BOARD_CAPTURES;
				if (captures) await fs.mkdir(captures, { recursive: true });
				const shot = async (stage: string) => {
					if (captures)
						await page.screenshot({
							path: path.join(captures, `work-board-${stage}-${language}-${theme}.png`),
							animations: "disabled",
							scale: "css",
						});
				};
				const board = page.getByRole("complementary", { name: TEXT[language].board });
				await expect(board).toBeVisible();

				// Waiting on the user comes first, and the status line says what is going on.
				await expect(board.locator("[data-board-section]").first()).toHaveAttribute(
					"data-board-section",
					"waiting",
				);
				await expect(board.locator('[data-board-waiting="board-confirm"]')).toContainText("Overwrite settings.ts?");
				await expect(board.locator(".omp-work-board-status")).toHaveCount(0);
				await expect(board.getByRole("status")).toHaveText(
					language === "en" ? "1 waiting on you" : "1개가 답변을 기다려요",
				);

				// Agents carry their model's mark, step and tokens; the parked one rests.
				const explore = board.locator('[data-board-agent="sa-explore"]');
				await expect(explore).toContainText("Map the settings code");
				await expect(explore).toContainText("Reading SettingsPage.tsx");
				await expect(explore).toContainText(language === "en" ? "48.2k tokens" : "48.2k개");
				await expect(explore.locator("[data-provider-mark]")).toBeVisible();

				// Todos: progress, the finished ones folded, the dock twin stepped aside.
				const todos = board.locator('[data-board-section="todos"]');
				await expect(todos).toContainText("3/7");
				await expect(todos).toContainText(language === "en" ? "3 done" : "3개 완료");
				await expect(todos.locator('[data-todo-status="in_progress"]')).toContainText("Wire the pref");
				await expect(page.locator('[data-dock-card="todo"]')).toBeHidden();
				await expect(page.locator("[data-workspace-island]")).toBeHidden();

				// The subscription account in use: its tightest window, the rest in the tooltip, a click opens the accounts page.
				const account = board.locator("[data-board-account]");
				await expect(account).toContainText("work@example.com");
				await expect(account.locator('[data-window="5h"] .omp-usage-gauge-text')).toHaveText("5H62%");
				await expect(account.locator('[data-window="7d"] .omp-usage-gauge-text')).toHaveText("7D41%");
				await expect(account).toHaveAttribute("title", /41%/);

				// The turn's token speed (the fake omp reports 64 tok/s) sits beside its elapsed time.
				await expect(board.locator('[data-board-section="turn"] .omp-work-board-aside')).toContainText("64 tok/s");

				// The goal's budget meter comes from get_goal.
				await expect(board.locator('[data-board-section="goal"]')).toContainText("74.0k / 200.0k");
				await expect(board.locator('[data-board-section="goal"] [role="progressbar"]').first()).toHaveAttribute(
					"aria-valuenow",
					"37",
				);

				await page.waitForTimeout(800);
				await shot("running");

				// ⌥B jumps to the waiting row.
				await page.locator("textarea").first().focus();
				await page.keyboard.press("Alt+KeyB");
				await expect(board.locator('[data-board-waiting="board-confirm"]')).toBeFocused();

				// A fold is kept (the pref), and unfolding brings the rows back.
				const fold = board.locator('[data-board-section="running"] button[aria-expanded]');
				await fold.click();
				await expect(explore).toHaveCount(0);
				await expect
					.poll(() => page.evaluate(() => window.omp.prefs.get("workBoardCollapsed")))
					.toEqual({ running: true });
				await fold.click();
				await expect(explore).toBeVisible();
				expect(await page.evaluate(() => window.omp.prefs.get("workBoardCollapsed"))).toEqual({});

				// The turn ends: the board sums it up.
				// Three providers report usage: the turn's end re-reads the quotas, and the board lists one row per
				// provider with its last-used account, the tab's own provider first and marked.
				await fixture(page, "fixture:usage-accounts:3");
				await fixture(page, "fixture:board-end");
				const accounts = board.locator("[data-board-account]");
				await expect(accounts).toHaveCount(3);
				await expect(accounts.locator(".omp-work-board-account-name .truncate")).toHaveText([
					"me@example.com",
					"side@example.com",
					"codex@example.com",
				]);
				await expect(accounts.first()).toHaveAttribute("data-in-use", "true");
				await expect(board.locator("[data-board-account][data-in-use]")).toHaveCount(1);
				await expect(board.locator('[data-board-section="last"]')).toBeVisible();
				await shot("idle");
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`the sidebar's usage block: one gauge line per provider with its last-used account's email, in use marked, a click opens accounts (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const { app, page, root } = await launch(language, theme);
			try {
				const captures = process.env.OMP_GUI_WORK_BOARD_CAPTURES;
				if (captures) await fs.mkdir(captures, { recursive: true });
				const shot = async (stage: string) => {
					if (captures)
						await page.screenshot({
							path: path.join(captures, `sidebar-usage-${stage}-${language}-${theme}.png`),
							animations: "disabled",
							scale: "css",
						});
				};
				const lines = page.locator("[data-rail-pin='usage'] .omp-sidebar-usage-line");
				// No subscription account (the fixture provider reports no windows): nothing in the footer.
				await expect(page.locator("[data-rail-pin='usage']")).toHaveCount(0);

				const emails = ["me@example.com", "side@example.com", "codex@example.com", "kimi@example.com"];
				for (const count of [1, 2, 3, 5]) {
					await fixture(page, `fixture:usage-accounts:${count}`);
					await page.reload();
					await page.waitForFunction(() => window.omp?.rpc != null);
					// One line per provider (never per account), the tab's own provider first.
					await expect(lines).toHaveCount(Math.min(count, 4));
					await expect(lines.first().locator('[data-window="5h"] .omp-usage-gauge-text')).toContainText("5H");
					await expect(lines.first().locator('[data-window="7d"] .omp-usage-gauge-text')).toContainText("7D");
					// Under each line the account that provider used last: its bare email, muted and truncated (with
					// five providers the others follow by company name, so only the first two are fixed).
					await expect(lines.locator(".omp-sidebar-usage-account")).toHaveText(
						count === 5
							? [emails[0] ?? "", emails[1] ?? "", /@example\.com$/, /@example\.com$/]
							: emails.slice(0, count),
					);
					expect(
						await lines
							.first()
							.locator(".omp-sidebar-usage-account")
							.evaluate(email => {
								const style = getComputedStyle(email);
								return { overflow: style.overflow, ellipsis: style.textOverflow, nowrap: style.whiteSpace };
							}),
					).toEqual({ overflow: "hidden", ellipsis: "ellipsis", nowrap: "nowrap" });
					if (count === 5) {
						await expect(page.locator(".omp-sidebar-usage-more")).toHaveText(
							language === "en" ? "+1 more" : "+1개 더 보기",
						);
					} else {
						await expect(page.locator(".omp-sidebar-usage-more")).toHaveCount(0);
					}
					if (count >= 2) {
						await expect(lines.nth(1)).not.toHaveAttribute("data-in-use", /.*/);
						await expect(lines.nth(1)).toHaveAttribute("title", /side@example\.com|codex@example\.com/);
					}
					// The fixture's own provider is the model in use: its line is the one marked, and the first.
					await expect(page.locator("[data-rail-pin='usage'] [data-in-use]")).toHaveCount(1);
					await expect(lines.first()).toHaveAttribute("data-in-use", "true");
					await expect(lines.first()).toHaveAttribute("data-rail-account", /^fixture:/);
					// A straight 2px edge, not an inset shadow that bends round the line's corners into a "(".
					expect(
						await lines.first().evaluate(line => {
							const edge = getComputedStyle(line, "::before");
							return { shadow: getComputedStyle(line).boxShadow, width: edge.width, content: edge.content };
						}),
					).toEqual({ shadow: "none", width: "2px", content: '""' });
					await expect(lines.first()).toHaveAttribute(
						"title",
						/^me@example\.com\n5H 15% · ↻ (2h \d+m|3h)\n7D 39% · ↻ 3d 23h/,
					);
					if (captures && count === 3)
						await fs.writeFile(
							path.join(captures, `sidebar-usage-tooltip-${language}-${theme}.txt`),
							(await lines.first().getAttribute("title")) ?? "",
						);
					await shot(`${count}`);
				}
				await lines.first().click();
				await expect(page.locator('button[data-destination="settings"]')).toHaveAttribute("aria-current", "page");
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
