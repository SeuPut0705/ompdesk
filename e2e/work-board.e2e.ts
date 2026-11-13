/**
 * The work board on the fake omp: a wide session pane docks this session's live state in its right
 * margin — the running subagents and the todo list here — and shifts the transcript and composer
 * columns left together. It leaves when the pane gets narrow and when the side panel opens; the
 * sidebar's usage block lists every account, grouped by provider. The board's sections, ⌥B and its folds are
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
	en: { board: "Work board", closePanel: "Close side panel", now: "Now" },
	ko: { board: "작업 현황", closePanel: "사이드 패널 닫기", now: "지금" },
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
				await expect(board.getByRole("heading", { name: text.now, exact: true })).toBeVisible();
				const explore = board.locator('[data-board-agent="sa-explore"]');
				await expect(explore).toContainText("Map the settings code");
				await expect(board.locator('[data-board-agent="sa-review"]')).toHaveCount(0);
				// The plan's count is said once, by the bar in the plan's own header.
				await expect(board.locator(".omp-work-board-progress")).toContainText("0/6");
				await expect(board.locator('[data-board-section="plan"]')).toContainText("Fixture task 1");

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
				// No close: nothing would open it again.
				await expect(board.getByRole("button", { name: /hide|close|숨기기|닫기/i })).toHaveCount(0);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

test("a 30-task plan's bar stays left of its count, and the count stays in the plan's header, narrow and with large text (en light)", async () => {
	test.setTimeout(180_000);
	const { app, page, root } = await launch("en", "light");
	try {
		// The docked board itself (a narrow pane shows a chip and sheet instead, which have no plan header line).
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
				const geometry = await board.locator('[data-board-section="plan"] .omp-work-board-title').evaluate(head => {
					const bar = head.querySelector("[data-progress-segments]");
					const count = head
						.querySelector(".omp-work-board-progress > span[aria-hidden]")
						?.getBoundingClientRect();
					const title = head.querySelector(".omp-work-board-zone-title")?.getBoundingClientRect();
					const headBox = head.getBoundingClientRect();
					const last = bar?.lastElementChild?.getBoundingClientRect();
					return {
						barClearOfCount: !!last && !!count && last.right <= count.left,
						barAfterTitle: !!bar && !!title && bar.getBoundingClientRect().left >= title.right,
						countInHead: !!count && count.right <= headBox.right,
					};
				});
				expect({ fontSize, width, ...geometry }).toEqual({
					fontSize,
					width,
					barClearOfCount: true,
					barAfterTitle: true,
					countInHead: true,
				});
			}
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`the sidebar's usage block: every account grouped by provider, the session's own marked, the gear opens accounts (${language} ${theme})`, async () => {
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
				const block = page.locator("[data-rail-pin='usage']");
				const groups = block.locator("[data-provider-row]");
				const accounts = block.locator("[data-usage-account]");
				// No subscription account (the fixture provider reports no windows): nothing in the footer.
				await expect(block).toHaveCount(0);

				// Providers the fixture adds with each count, and the accounts they hold in all.
				const accountsOf: Record<number, number> = { 1: 1, 2: 3, 3: 5, 5: 7 };
				for (const count of [1, 2, 3, 5]) {
					await fixture(page, `fixture:usage-accounts:${count}`);
					await page.reload();
					await page.waitForFunction(() => window.omp?.rpc != null);
					// One group per provider and a row per account, none left to Settings, the tab's own provider first.
					await expect(groups).toHaveCount(count);
					await expect(accounts).toHaveCount(accountsOf[count] ?? 0);
					await expect(groups.first()).toHaveAttribute("data-provider-row", "fixture");
					await expect(accounts.first().locator('[data-window="5h"] .omp-usage-gauge-text')).toContainText("5H");
					await expect(accounts.first().locator('[data-window="7d"] .omp-usage-gauge-text')).toContainText("7D");
					await expect(accounts.first().locator(".omp-usage-gauge-reset").first()).toContainText("↻");
					// The session's own account is marked, and only it.
					await expect(block.locator("[data-in-use]")).toHaveCount(1);
					await expect(accounts.first()).toHaveAttribute("data-in-use", "true");
					await expect(accounts.first()).toContainText(language === "en" ? "In use" : "사용 중");
					// The address is whole (it wraps, never an ellipsis); the full label, parenthetical too, is the tooltip.
					const label = accounts.first().locator("[data-account-label]");
					await expect(label).toHaveText("me@example.com");
					await expect(label).toHaveAttribute("title", "me@example.com (me…)");
					if (count >= 2) {
						// Both Claude accounts, in a fixed order by address, neither marked.
						const claude = block.locator('[data-provider-row="anthropic"]');
						const emails = claude.locator("[data-usage-account] [data-account-label]");
						await expect(emails).toHaveText(["side@example.com", "work@example.com"]);
						await expect(claude.locator("[data-in-use]")).toHaveCount(0);
					}
					const cut = await block.locator("[data-usage-account] [data-account-label]").evaluateAll(
						labels =>
							labels.filter(entry => {
								const style = getComputedStyle(entry);
								return style.textOverflow === "ellipsis" || entry.scrollWidth > entry.clientWidth + 1;
							}).length,
					);
					expect(cut, "no address is cut").toBe(0);
					// The groups scroll inside a height cap: 18rem, at most 40 % of the window.
					const scroller = await block.locator("[data-sidebar-usage-scroll]").evaluate(list => {
						const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
						return {
							height: list.getBoundingClientRect().height,
							cap: Math.min(18 * rem, innerHeight * 0.4),
							overflowY: getComputedStyle(list).overflowY,
						};
					});
					expect(scroller.height).toBeLessThanOrEqual(scroller.cap + 1);
					expect(scroller.overflowY).toBe("auto");
					if (captures && count === 3)
						await fs.writeFile(
							path.join(captures, `sidebar-usage-tooltip-${language}-${theme}.txt`),
							(await accounts.first().locator("[data-quota-updated]").getAttribute("title")) ?? "",
						);
					await shot(`${count}`);
				}
				await block.locator("[data-sidebar-usage-open]").click();
				await expect(page.locator('button[data-destination="settings"]')).toHaveAttribute("aria-current", "page");
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

/** The pane's transcript, the room the ask dock wrote for its card, and the work strip's height (0 without one). */
interface PromptRoom {
	transcript: number;
	room: number;
	strip: number;
}

const promptRoom = (page: Page): Promise<PromptRoom> =>
	page.evaluate(() => {
		const pane = document.querySelector(".omp-session-pane");
		const transcript = pane?.querySelector(".omp-transcript-editorial")?.getBoundingClientRect().height ?? 0;
		const askDock = pane?.querySelector<HTMLElement>(".omp-ask-dock");
		const strip = pane?.querySelector(".omp-work-strip")?.getBoundingClientRect().height ?? 0;
		return {
			transcript,
			room: Number.parseFloat(askDock?.style.getPropertyValue("--omp-prompt-room") ?? ""),
			strip,
		};
	});

test("after a session switch in the same tab, the room above the composer follows the work strip coming and going (en light)", async () => {
	test.setTimeout(180_000);
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-work-board-switch-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	// A stored session of this folder, which the session picker switches the tab to in place.
	const stored = path.join(agent, "sessions", "seeded", "switched-1.jsonl");
	await fs.mkdir(path.dirname(stored), { recursive: true });
	const at = new Date().toISOString();
	await fs.writeFile(
		stored,
		`${[
			{ type: "title", v: 1, title: "The switched session", updatedAt: at },
			{ type: "session", version: 3, id: "switched-1", timestamp: at, cwd: project },
			{ type: "message", id: "s-1", parentId: null, timestamp: at, message: { role: "user", content: "Earlier" } },
			{
				type: "message",
				id: "s-2",
				parentId: "s-1",
				timestamp: at,
				message: { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
			},
		]
			.map(line => JSON.stringify(line))
			.join("\n")}\n`,
	);
	const app = await launchApp({ project, desktop, agent, profile: root, env: { OMP_GUI_TEST_SESSION_FILES: "1" } });
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(error.message));
		await resize(app, 1600, 1000);
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		await send(page, "hello");
		const [tab] = await page.evaluate(() => window.omp.tabs.list());

		// The session picker switches this tab to the stored session: still one tab, now on the other file.
		const option = page.getByRole("option").filter({ hasText: "The switched session" });
		await expect(async () => {
			if (!(await page.getByRole("dialog").isVisible())) await page.keyboard.press("ControlOrMeta+Shift+F");
			await expect(option).toBeVisible({ timeout: 5_000 });
		}).toPass({ timeout: 30_000 });
		await option.click();
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).map(entry => entry.sessionPath), {
				timeout: 30_000,
			})
			.toEqual([stored]);
		expect((await page.evaluate(() => window.omp.tabs.list()))[0]?.tabId).toBe(tab?.tabId);
		await expect(page.getByText("Earlier answer")).toBeVisible({ timeout: 30_000 });

		// A plan and an 8-option question: the board docks beside the pane, no strip; the transcript keeps its floor.
		await fixture(page, "fixture:todo");
		await fixture(page, "fixture:select 8");
		await expect(page.locator("[data-prompt-card]")).toContainText("Follow-up 8");
		await expect(page.locator("aside[data-work-board-panel]")).toBeVisible();
		await expect.poll(async () => (await promptRoom(page)).transcript).toBeGreaterThanOrEqual(240);
		// The card writes its room as it lays out (547 px, 563 px under load, then back): the baseline is read once two
		// reads a frame apart agree, or the later comparison measures the layout still settling.
		let docked = await promptRoom(page);
		await expect
			.poll(async () => {
				const before = docked;
				docked = await promptRoom(page);
				await page.evaluate(() => {
					const { promise, resolve } = Promise.withResolvers<null>();
					requestAnimationFrame(() => resolve(null));
					return promise;
				});
				return docked.room === before.room && docked.transcript === before.transcript;
			})
			.toBe(true);
		expect(docked.strip).toBe(0);

		// The side panel takes the board's margin: the strip appears and the card's room gives up its height.
		const settled = async (until: (read: PromptRoom) => boolean) => {
			let last = await promptRoom(page);
			await expect
				.poll(async () => {
					const before = last;
					last = await promptRoom(page);
					await page.evaluate(() => {
						const { promise, resolve } = Promise.withResolvers<null>();
						requestAnimationFrame(() => resolve(null));
						return promise;
					});
					return until(last) && last.room === before.room && last.transcript === before.transcript;
				})
				.toBe(true);
			return last;
		};
		await page.keyboard.press("ControlOrMeta+j");
		await expect(page.locator("[data-work-strip]")).toBeVisible();
		const open = await settled(read => read.strip > 0 && read.transcript >= 240);

		// Closed again: the strip goes and the room comes back.
		await page.keyboard.press("ControlOrMeta+j");
		await expect(page.locator("[data-work-strip]")).toHaveCount(0);
		const closed = await settled(read => read.strip === 0 && read.transcript >= 240);
		// Nightlies 41906983008 and 41921143051: the baseline read 563 px where the run settled at 547 (open 507 + a 40 px
		// strip), so every number goes into the message, not only the one that failed.
		const numbers = JSON.stringify({ docked, open, closed });
		expect(
			Math.abs(docked.room - open.strip - open.room),
			`room follows the strip in: ${numbers}`,
		).toBeLessThanOrEqual(1);
		expect(closed.room, `room comes back out: ${numbers}`).toBe(docked.room);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
