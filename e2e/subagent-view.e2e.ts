/**
 * The side panel's Subagent view on the fake omp (`fixture:subagents:transcript`: a running subagent with
 * thinking, read/bash/edit calls, a long markdown reply with code and a wide table, and a bash still going).
 * The view is the main transcript's own components at the panel's width, so this pins what the user sees:
 * one-line header (name and model mark, status, tokens, clock, open/stop/copy), the editorial turns and
 * tool cards, the composer-styled steer box, no horizontal overflow at 380 and 520 px (and at 320 px), long
 * code and a wide table scrolling inside their own block, live updates that follow the tail without
 * remounting rows, and "Jump to latest" once the reader scrolls away. Captures: light/dark × en/ko ×
 * 380/520 px, into `OMP_GUI_SUBAGENT_SHOTS` (default: the test output).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { capture, captureTo, exitApp, launchApp, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const SHOTS = process.env.OMP_GUI_SUBAGENT_SHOTS;

const TEXT = {
	en: {
		openInPanel: "Open in side panel",
		openFull: "Open full transcript",
		copy: "Copy transcript",
		stop: "Stop",
		jump: "Jump to latest",
		steerPlaceholder: "Add an instruction…",
		running: "running",
	},
	ko: {
		openInPanel: "사이드 패널에서 열기",
		openFull: "전체 기록 열기",
		copy: "기록 복사",
		stop: "중단",
		jump: "최신으로 이동",
		steerPlaceholder: "추가 지시 입력…",
		running: "실행 중",
	},
} as const;

async function launch(
	language: Language,
	theme: Theme,
	panelWidth: number,
): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-subagent-view-")));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		// electron-store reads `gui.panelWidth` as a nested path.
		JSON.stringify({ language, themeName: theme, firstRunComplete: true, gui: { panelWidth } }),
	);
	const app = await launchApp({ project, desktop, agent, profile });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile };
}

async function fixture(page: Page, line: string): Promise<void> {
	const response = await page.evaluate(command => window.omp.rpc.command({ type: "bash", command }), line);
	expect(response.success).toBe(true);
}

/** One capture: into the shots directory when one is set, else the test's output. */
async function shot(page: Page, name: string): Promise<void> {
	if (SHOTS) await captureTo(SHOTS, page, name);
	else await capture(page, name);
}

/** Nothing of the panel spills sideways: not the view, the scroller, nor any row inside it. */
async function expectNoHorizontalOverflow(view: Locator): Promise<void> {
	const overflow = await view.evaluate(root => {
		const box = root.getBoundingClientRect();
		const spilled: string[] = [];
		for (const element of root.querySelectorAll<HTMLElement>(".omp-transcript-scroll, .omp-transcript-row")) {
			if (element.scrollWidth > element.clientWidth + 1)
				spilled.push(`${element.className} ${element.scrollWidth}>${element.clientWidth}`);
		}
		for (const element of root.querySelectorAll<HTMLElement>(
			".omp-transcript-row, .omp-subagent-header, [data-subagent-steer]",
		)) {
			const right = element.getBoundingClientRect().right;
			if (right > box.right + 1) spilled.push(`${element.className} right ${right} > ${box.right}`);
		}
		return spilled;
	});
	expect(overflow).toEqual([]);
}

async function atTail(scroller: Locator): Promise<boolean> {
	return scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight <= 2);
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		for (const width of variants([380, 520] as const))
			test(`subagent view: header, turns, tool cards, steer, live follow (${language} ${theme} ${width}px)`, async () => {
				test.setTimeout(180_000);
				const text = TEXT[language];
				const { app, page, profile } = await launch(language, theme, width);
				try {
					const errors: string[] = [];
					page.on("pageerror", error => errors.push(error.message));
					await fixture(page, "fixture:subagents");
					await fixture(page, "fixture:subagents:transcript");
					await page.locator("[data-sidebar-subagents-toggle]").first().click();
					await page.locator('[data-sidebar-subagent="sa-explore"]').click({ button: "right" });
					await page.getByRole("menuitem", { name: text.openInPanel }).click();
					await expect(page.getByRole("menu")).toHaveCount(0);

					const aside = page.locator("aside[data-docked]");
					const view = aside.locator('[data-panel-subagent="sa-explore"]');
					await expect(view).toBeVisible();
					const asideBox = await aside.boundingBox();
					expect(Math.abs((asideBox?.width ?? 0) - width)).toBeLessThanOrEqual(2);

					// Header: one line, name and model mark left, status/tokens/clock/actions right.
					const header = view.locator(".omp-subagent-header");
					await expect(header).toContainText("explore");
					await expect(header.locator('[data-provider-mark="anthropic"]')).toBeVisible();
					await expect(header.locator("[data-subagent-status]")).toHaveAttribute(
						"data-subagent-status",
						"running",
					);
					await expect(header.locator("[data-subagent-status]")).toContainText("48.");
					await expect(header.getByRole("button", { name: text.openFull })).toBeVisible();
					await expect(header.getByRole("button", { name: text.stop })).toBeVisible();
					await expect(header.getByRole("button", { name: text.copy })).toBeVisible();
					const headerBox = await header.boundingBox();
					expect(headerBox?.height ?? 99).toBeLessThanOrEqual(48);
					// One row: every part of the header shares one vertical center.
					const centers = await header
						.locator(":scope > div")
						.evaluateAll(parts =>
							parts.map(part => part.getBoundingClientRect().top + part.getBoundingClientRect().height / 2),
						);
					expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);

					// The transcript is the main one's own components under the editorial styles.
					const scroller = view.locator(".omp-transcript-scroll");
					await expect(view.locator(".omp-transcript-editorial.omp-subagent-conversation")).toBeVisible();
					await expect(view.locator(".omp-user-bubble")).toContainText("Map the settings code");
					await expect(view.locator(".markdown-body h2")).toContainText("Settings map");
					await expect(view.locator(".markdown-body pre")).toBeVisible();
					await expect(view.locator(".markdown-body table")).toBeVisible();
					await expect(view.locator(".omp-execution-group").first()).toBeVisible();
					await expect(view.locator("[data-subagent-steer] textarea")).toBeVisible();
					await expect(view.locator("[data-subagent-steer] .omp-composer-box")).toBeVisible();
					await expect.poll(() => atTail(scroller)).toBe(true);
					await expectNoHorizontalOverflow(view);

					// Long code and the wide table scroll inside their own block.
					const code = view.locator(".markdown-body pre").first();
					expect(await code.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
					const table = view.locator(".markdown-body table").first();
					expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
					await shot(page, `${language}-${theme}-${width}-panel`);

					// Work cards open to the same tool cards as the main transcript (read, bash, edit diff).
					for (const header of await view.locator(".omp-execution-group-header").all()) await header.click();
					await expect(view.locator(".omp-tool-header").first()).toBeVisible();
					const editCard = view
						.locator(".omp-tool-header")
						.filter({ hasText: /settings\.ts/ })
						.last();
					await editCard.click();
					await editCard.scrollIntoViewIfNeeded();
					await expectNoHorizontalOverflow(view);
					await shot(page, `${language}-${theme}-${width}-expanded`);
					for (const header of await view.locator(".omp-execution-group-header").all()) await header.click();

					// Live: the follower keeps the tail without remounting any row.
					await scroller.evaluate(element => {
						element.scrollTop = element.scrollHeight;
					});
					await expect.poll(() => atTail(scroller)).toBe(true);
					await expect(view.getByRole("button", { name: text.jump })).toHaveCount(0);
					const firstRow = view.locator(".omp-transcript-row").first();
					await firstRow.evaluate(element => {
						(element as HTMLElement & { __kept?: boolean }).__kept = true;
					});
					await fixture(page, "fixture:subagents:append");
					await expect(view.getByText("Tests are still running (update 9).")).toBeVisible({ timeout: 15_000 });
					await expect.poll(() => atTail(scroller)).toBe(true);
					await fixture(page, "fixture:subagents:append");
					await expect(view.getByText("Tests are still running (update 10).")).toBeVisible({ timeout: 15_000 });
					expect(
						await firstRow.evaluate(
							element => element.isConnected && (element as HTMLElement & { __kept?: boolean }).__kept === true,
						),
					).toBe(true);

					// Reading earlier output: nothing moves the view, "Jump to latest" appears and brings it back.
					const jump = view.getByRole("button", { name: text.jump });
					await scroller.hover();
					await page.mouse.wheel(0, -400);
					await expect(jump).toBeVisible();
					const held = await scroller.evaluate(element => element.scrollTop);
					await fixture(page, "fixture:subagents:append");
					await expect(view.getByText("Tests are still running (update 11).")).toHaveCount(1, { timeout: 15_000 });
					expect(Math.abs((await scroller.evaluate(element => element.scrollTop)) - held)).toBeLessThanOrEqual(1);
					await shot(page, `${language}-${theme}-${width}-jump`);
					await jump.click();
					await expect.poll(() => atTail(scroller)).toBe(true);

					// Steer: typed text sits in the composer-styled box; Enter sends it.
					const steer = view.locator("[data-subagent-steer]");
					await steer.getByPlaceholder(text.steerPlaceholder).fill("Check the keyboard settings too");
					await shot(page, `${language}-${theme}-${width}-steer`);
					await expectNoHorizontalOverflow(view);

					// The full transcript opens in the sheet.
					await view.getByRole("button", { name: text.openFull }).click();
					await expect(page.locator('[role="dialog"] .omp-subagent-conversation')).toBeVisible();
					await shot(page, `${language}-${theme}-${width}-sheet`);
					await page.keyboard.press("Escape");
					await expect(page.locator('[role="dialog"]')).toHaveCount(0);

					// Narrowest supported column: the header stays one line and nothing spills.
					if (width === 380) {
						await view.evaluate(element => {
							element.style.flex = "1 1 0";
							element.style.maxWidth = "320px";
						});
						await expectNoHorizontalOverflow(view);
						const narrow = await header.boundingBox();
						expect(narrow?.height ?? 99).toBeLessThanOrEqual(48);
						await shot(page, `${language}-${theme}-320-panel`);
					}
					expect(errors).toEqual([]);
				} finally {
					await exitApp(app);
					await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
				}
			});
