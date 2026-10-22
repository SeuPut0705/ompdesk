/**
 * The work board on the fake omp: a wide session pane docks this session's live state in its right
 * margin — the running subagents and the todo list here — and shifts the transcript and composer
 * columns left together. It leaves when the pane gets narrow and when the side panel opens; the
 * sidebar's usage block lists one gauge line per provider. The board's sections, ⌥B and its folds are
 * component-tested (WorkBoard, work-board-focus). Captures go to `OMP_GUI_WORK_BOARD_CAPTURES`
 * (default: the test output directory).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { exitApp, launchApp, variants } from "./harness";

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

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`the work board docks in a wide pane and steps aside for a narrow one and the side panel (${language} ${theme})`, async () => {
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

				// Nothing to show before the first turn: no board takes the margin.
				await expect(page.locator(".omp-composer-input").first()).toBeVisible({ timeout: 30_000 });
				await expect(board).toHaveCount(0);
				await expect(pane).not.toHaveAttribute("data-work-board", "");

				// A finished turn that changed no file draws no "Changed" line.
				await send(page, "hello");
				await expect(page.locator("[data-transcript-kind]").first()).toBeVisible({ timeout: 30_000 });
				await expect(board.locator('[data-board-session="changes"]')).toHaveCount(0);

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
				// Columns line up; subpixel rounding of the shifted columns may differ by a pixel or two (the
				// window's width on a hosted runner is odd, so each column's half pixel rounds its own way).
				expect(
					Math.abs((await left(page.locator(".omp-transcript-row").first())) - (await left(shell))),
				).toBeLessThanOrEqual(2);
				// The dock strips that say what the board says step aside while it shows.
				await expect(page.locator("[data-workspace-island]")).toBeHidden();
				await expect(page.locator('[data-dock-card="todo"]')).toBeHidden();
				await capture("wide");

				// A narrow window has no room, even beside a narrowed column (a 1000 px window's pane is about 750 px): the
				// board goes, the columns centre again and the status strip says the plan and the running work in its
				// place, so the dock's island and todo card still step aside.
				await resize(app, 1000, 900);
				await expect(board).toHaveCount(0);
				await expect(pane).not.toHaveAttribute("data-work-board", "");
				await expect(page.locator("[data-work-strip]")).toBeVisible();
				await expect(page.locator("[data-workspace-island]")).toBeHidden();
				await expect(page.locator('[data-dock-card="todo"]')).toBeHidden();
				await capture("narrow");
				await resize(app, 1600, 900);
				await expect(board).toBeVisible();

				// Opening a subagent opens the side panel, and the board steps aside for it.
				await explore.click();
				await expect(page.locator("aside[data-docked]")).toBeVisible();
				await expect(board).toHaveCount(0);
				await expect(pane).not.toHaveAttribute("data-work-board", "");
				await expect(page.locator("[data-work-strip]")).toBeVisible();
				await expect(page.locator("[data-workspace-island]")).toBeHidden();
				await expect(page.locator('[data-dock-card="todo"]')).toBeHidden();
				await page.getByRole("button", { name: text.closePanel }).click();
				await expect(page.locator("[data-workspace-island]")).toBeHidden();
				await expect(page.locator('[data-dock-card="todo"]')).toBeHidden();
				await expect(board).toBeVisible();

				// The board's own button hides it for this window; nothing is stored.
				await board.getByRole("button", { name: text.hide }).click();
				await expect(board).toHaveCount(0);
				expect(await page.evaluate(() => window.omp.prefs.get("workBoard"))).toBeUndefined();
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

test("a 30-task plan's bar stays left of its count, and the count and close stay in the head, narrow and with large text (en light)", async () => {
	test.setTimeout(180_000);
	const { app, page, root } = await launch("en", "light");
	try {
		// The docked board itself (a narrow pane shows a chip and sheet instead, which have no head line).
		const board = page.locator("aside[data-work-board-panel]").first();
		await send(page, "hello");
		await fixture(page, "fixture:todo 30");
		await expect(board.locator(".omp-work-board-progress")).toContainText("15/30");
		// A window just wide enough for the board to dock, and a wide one; then each again with large text.
		for (const fontSize of [15, 20])
			for (const width of [1400, 1920]) {
				await page.evaluate(size => {
					const scaled = `${size}px`;
					document.body.style.fontSize = scaled;
					document.documentElement.style.setProperty("--gui-font-size", scaled);
				}, fontSize);
				await resize(app, width, 900);
				await expect(board, `board docked at ${width} px, ${fontSize} px text`).toBeVisible();
				const geometry = await board.locator(".omp-work-board-head").evaluate(head => {
					const box = (selector: string) => head.querySelector(selector)?.getBoundingClientRect();
					const bar = head.querySelector(".omp-work-board-segments");
					const count = head
						.querySelector(".omp-work-board-progress > span[aria-hidden]")
						?.getBoundingClientRect();
					const close = box(".omp-work-board-hide");
					const name = box(".omp-work-board-name");
					const headBox = head.getBoundingClientRect();
					const last = bar?.lastElementChild?.getBoundingClientRect();
					return {
						barClearOfCount: !!last && !!count && last.right <= count.left,
						barAfterName: !!bar && !!name && bar.getBoundingClientRect().left >= name.right,
						countInHead: !!count && count.right <= headBox.right,
						closeInHead: !!close && close.right <= headBox.right + 0.5,
					};
				});
				expect({ fontSize, width, ...geometry }).toEqual({
					fontSize,
					width,
					barClearOfCount: true,
					barAfterName: true,
					countInHead: true,
					closeInHead: true,
				});
			}
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
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
					// No edge or shadow marks the line in use (32bcf114); the tooltip names the in-use account.
					expect(
						await lines.first().evaluate(line => {
							const edge = getComputedStyle(line, "::before");
							return { shadow: getComputedStyle(line).boxShadow, content: edge.content };
						}),
					).toEqual({ shadow: "none", content: "none" });
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
