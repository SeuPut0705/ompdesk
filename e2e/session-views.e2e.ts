/**
 * Region A views on the fake omp (MixA6/MixA7):
 * - file cards (A26/A111, cc765fa): the composer chips each `@path` the draft
 *   names with its name, its type and size in the tooltip and no preview (the
 *   compact chips of 15a52353; a word that names no file gets none) and × takes
 *   the mention out; a reply's Excel, CSV and PowerPoint files get cards under
 *   it, a removed one draws nothing (a reply's PDF page: chat-media.e2e.ts);
 * - the side panel's Subagent view (A81): a sidebar subagent row dragged onto
 *   the session opens its transcript in the side panel, and the row menu's
 *   "Open in side panel" does the same for another agent;
 * - drag-selecting in the transcript (A105): a drag held past the top edge
 *   scrolls the transcript and the selection survives the rows it scrolled past;
 * - the context inspector (A61/A60, 3410dd8): Stats › This session splits the
 *   context into eight categories, Inspect shows the 200-block grid, filters by
 *   category (an xd:// tool is Deferred), opens an entry's provider text (the
 *   32k cap says so) and warns when the context outgrows the window.
 * Captures: light/dark × en/ko and a narrow window.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { tinyPptx, tinyXlsx } from "./file-viewer-fixtures";
import { capture, exitApp, launchApp, openDestination, openSidebarFamily, variants } from "./harness";
import { tinyPdf } from "./tiny-pdf";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const TEXT = {
	en: {
		cards: "Attached files",
		replyFiles: "Files in this reply",
		remove: "Remove notes.txt",
		openInPanel: "Open in side panel",
		subagentTitle: "Subagent",
		inspect: "Inspect",
		inspector: "Context inspector",
		mcp: "MCP tools",
		files: "Instruction files",
		all: "All",
		deferred: "Deferred",
		truncated: /Showing the first 32,000 of 44,000 characters/,
		over: "The context is larger than the model's window",
	},
	ko: {
		cards: "첨부한 파일",
		replyFiles: "이 답변의 파일",
		remove: "notes.txt 빼기",
		openInPanel: "사이드 패널에서 열기",
		subagentTitle: "서브에이전트",
		inspect: "자세히 보기",
		inspector: "컨텍스트 들여다보기",
		mcp: "MCP 도구",
		files: "컨텍스트 파일",
		all: "전체",
		deferred: "지연 로드",
		truncated: /44,000자 중 처음 32,000자를 보여 줘요/,
		over: "컨텍스트가 모델의 컨텍스트 창보다 커요",
	},
} as const;

async function launch(
	language: Language,
	theme: Theme,
	contextOver: boolean,
): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-session-views-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(path.join(project, "docs"), { recursive: true }), fs.mkdir(desktop), fs.mkdir(agent)]);
	await Promise.all([
		fs.writeFile(path.join(project, "docs", "spec.pdf"), tinyPdf()),
		fs.writeFile(path.join(project, "docs", "q3.xlsx"), await tinyXlsx()),
		fs.writeFile(path.join(project, "docs", "deck.pptx"), await tinyPptx()),
		fs.writeFile(path.join(project, "docs", "table.csv"), "Region,Total\nNorth,1234.5\nSouth,980\n"),
		fs.writeFile(path.join(project, "docs", "notes.txt"), "Ship the cards\nthen the inspector\n"),
		fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		),
	]);
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			...(contextOver ? { OMP_GUI_TEST_CONTEXT_OVER: "1" } : {}),
		},
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile };
}

/** A `bash` line the fake omp reads as a fixture command. */
async function fixture(page: Page, line: string): Promise<void> {
	const response = await page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), line);
	expect(response.success).toBe(true);
}

async function send(page: Page, text: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(text);
	await input.press("Enter");
	await expect(input).toHaveValue("");
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`file cards, subagent panel, drag-select and context inspector (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const text = TEXT[language];
			// One run outgrows the window: the inspector warns.
			const contextOver = language === "ko" && theme === "dark";
			const { app, page, profile } = await launch(language, theme, contextOver);
			try {
				const errors: string[] = [];
				page.on("pageerror", error => errors.push(error.message));
				const input = page.locator("textarea").first();

				// ── File cards in the composer ──────────────────────────────────
				await input.fill("Compare @docs/spec.pdf @docs/q3.xlsx @docs/notes.txt and @nothing-here.md please");
				const draftCards = page.getByRole("group", { name: text.cards });
				await expect(draftCards.locator('[data-file-card][data-state="ready"]')).toHaveCount(3, {
					timeout: 15_000,
				});
				await expect(draftCards.locator("[data-file-card]")).toHaveCount(3);
				// Compact chips: the type and size are the tooltip; no chip reads or draws a preview.
				await expect(draftCards.locator('[data-file-card="pdf"]')).toHaveAttribute(
					"title",
					/^docs\/spec\.pdf\nPDF · /,
				);
				await expect(draftCards.locator('[data-file-card="spreadsheet"]')).toHaveAttribute(
					"title",
					/^docs\/q3\.xlsx\nExcel · /,
				);
				await expect(draftCards.locator('[data-file-card="text"]')).toContainText("notes.txt");
				await expect(draftCards.locator("canvas, table, pre")).toHaveCount(0);
				await capture(page, `${language}-${theme}-composer-cards`);
				if (language === "en" && theme === "dark") {
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 860));
					await capture(page, "narrow-en-dark-composer-cards");
					await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
				}
				await draftCards.getByRole("button", { name: text.remove }).click();
				await expect(input).not.toHaveValue(/@docs\/notes\.txt/);
				await expect(input).toHaveValue(/@docs\/spec\.pdf/);
				await expect(draftCards.locator("[data-file-card]")).toHaveCount(2);
				await input.fill("");
				await expect(draftCards).toHaveCount(0);

				// ── File cards under a reply ────────────────────────────────────
				await send(page, "fixture documents");
				const replyCards = page.getByRole("group", { name: text.replyFiles }).last();
				// The fixture's fourth file is gone: a reply draws nothing for it, never a "Deleted" card (32a4f3dab).
				await expect(replyCards.locator("[data-file-card]")).toHaveCount(3, { timeout: 30_000 });
				await expect(replyCards.locator('[data-file-card="spreadsheet"][data-state="ready"]')).toContainText(
					"Excel · ",
				);
				await expect(replyCards.locator('[data-file-card="csv"][data-state="ready"]')).toContainText("North");
				await expect(replyCards.locator('[data-file-card="presentation"][data-state="ready"]')).toContainText(
					"Roadmap 2025",
				);
				await expect(replyCards.locator('[data-file-card][data-state="missing"]')).toHaveCount(0);
				await replyCards.scrollIntoViewIfNeeded();
				await capture(page, `${language}-${theme}-reply-cards`);

				// ── A subagent in the side panel (drag, then the row menu) ──────
				await fixture(page, "fixture:subagents");
				await openSidebarFamily(page);
				const explore = page.locator('[data-sidebar-subagent="sa-explore"]');
				const pane = page.locator(".omp-session-pane").first();
				const from = await explore.boundingBox();
				const to = await pane.boundingBox();
				if (!from || !to) throw new Error("expected the subagent row and the session pane");
				await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
				await page.mouse.down();
				await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 4 });
				// Playwright's intercepted drag fires dragover per move; the last nudge settles it on the target.
				await page.mouse.move(to.x + to.width * 0.6 + 2, to.y + to.height / 2, { steps: 12 });
				await page.mouse.move(to.x + to.width * 0.6, to.y + to.height / 2, { steps: 2 });
				await expect(page.locator("[data-subagent-ghost]")).toBeVisible();
				await capture(page, `${language}-${theme}-subagent-drag`);
				await page.mouse.up();
				const aside = page.locator("aside[data-docked]");
				await expect(aside.locator('[data-panel-subagent="sa-explore"]')).toContainText("Map the settings code");
				await expect(aside).toContainText(text.subagentTitle);
				await expect(aside.locator("[data-subagent-steer]")).toBeVisible();
				await expect(explore.locator("button").first()).toHaveAttribute("aria-current", "true");
				await capture(page, `${language}-${theme}-subagent-panel`);

				const nested = page.locator('[data-sidebar-subagent="sa-nested"]');
				await nested.click({ button: "right" });
				await page.getByRole("menuitem", { name: text.openInPanel }).click();
				await expect(aside.locator('[data-panel-subagent="sa-nested"]')).toContainText("Read locale files");
				await expect(page.locator('[role="dialog"]')).toHaveCount(0);

				// ── Drag-select past the top edge (one run is enough) ───────────
				if (language === "en" && theme === "light") {
					for (let turn = 0; turn < 18; turn++) await send(page, `fixture turn ${turn}`);
					const scroller = page.locator(".omp-transcript-scroll").first();
					await expect(page.locator(".omp-user-text").filter({ hasText: "fixture turn 17" })).toBeVisible();
					await scroller.evaluate(element => {
						element.scrollTop = element.scrollHeight;
					});
					const last = page.locator(".omp-user-text").filter({ hasText: "fixture turn 17" });
					// The last turns' rows rise into place (omp-row-arrive); measured mid-rise, the
					// press would land where the text no longer is.
					await expect
						.poll(() =>
							scroller.evaluate(element =>
								[...element.querySelectorAll(".omp-row-arrive > .omp-transcript-row")].some(row =>
									row.getAnimations().some(animation => animation.playState === "running"),
								),
							),
						)
						.toBe(false);
					const start = await last.boundingBox();
					const box = await scroller.boundingBox();
					if (!start || !box) throw new Error("expected the last prompt and the transcript");
					const before = await scroller.evaluate(element => element.scrollTop);
					// A whole-device-pixel press, as a mouse reports it (125 % display scaling is not whole in CSS
					// pixels). Chromium places the press caret from the point as sent, but on the first drag move it
					// hit-tests the press point again floored to whole pixels (SelectionController::HandleMouseDraggedEvent).
					// A fractional point just right of a glyph's middle gives two offsets, and the
					// changed caret restarts the selection at the pointer on every move.
					const dpr = await page.evaluate(() => window.devicePixelRatio);
					const wholePixel = (value: number) => Math.round(value * dpr) / dpr;
					await page.mouse.move(wholePixel(start.x + start.width - 4), wholePixel(start.y + start.height / 2));
					await page.mouse.down();
					await page.mouse.move(start.x + 10, box.y + 60, { steps: 6 });
					// Held just inside the top edge: the transcript keeps scrolling on its own.
					await page.mouse.move(start.x + 10, box.y + 4, { steps: 2 });
					await expect
						.poll(() => scroller.evaluate(element => element.scrollTop), { timeout: 10_000 })
						.toBeLessThan(before - 600);
					const held = await page.evaluate(() => {
						const selection = window.getSelection();
						return {
							text: selection?.toString() ?? "",
							anchorMounted: selection?.anchorNode?.isConnected === true,
						};
					});
					expect(held.anchorMounted).toBe(true);
					// The anchor sits inside "fixture turn 17"; every turn above it is selected whole.
					expect(held.text).toContain("fixture turn 16");
					expect(held.text).toContain("fixture turn 14");
					await page.mouse.up();
					await capture(page, "en-light-drag-select");
					const copied = await page.evaluate(() => window.getSelection()?.toString() ?? "");
					expect(copied).toContain("fixture turn 16");
				}

				// ── Context inspector ───────────────────────────────────────────
				// The palette's "context" row opens Stats for this session, the scope this view reads.
				await openDestination(page, "insights", "context");
				const stats = page.locator('section[data-destination="insights"]');
				await expect(stats.getByText(text.files, { exact: true })).toBeVisible({ timeout: 15_000 });
				await expect(stats.getByText(text.mcp, { exact: true })).toBeVisible();
				await capture(page, `${language}-${theme}-context-breakdown`);
				await stats.getByRole("button", { name: text.inspect }).click();
				const sheet = page.getByRole("dialog", { name: text.inspector });
				await expect(sheet.getByTestId("context-grid").locator("span")).toHaveCount(200);
				if (contextOver) await expect(sheet).toContainText(text.over);
				else await expect(sheet).not.toContainText(text.over);
				await capture(page, `${language}-${theme}-inspector`);

				await sheet.getByRole("button", { name: new RegExp(`^${text.mcp}`) }).click();
				await expect(sheet.locator("li")).toHaveCount(2);
				await expect(sheet.locator("li").filter({ hasText: "mcp__rea__analyze_function" })).toContainText(
					text.deferred,
				);
				await capture(page, `${language}-${theme}-inspector-mcp`);
				await sheet.getByRole("button", { name: text.all, exact: true }).click();
				await sheet.locator("li button").filter({ hasText: "AGENTS.md" }).click();
				await expect(sheet).toContainText("Keep every change small.");
				await sheet.locator("li button").filter({ hasText: "The settings live in" }).click();
				await expect(sheet).toContainText(text.truncated);
				await capture(page, `${language}-${theme}-inspector-entry`);
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
