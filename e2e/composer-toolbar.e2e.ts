/**
 * The composer toolbar, measured (Run chip + reserved slots + toolbar-owned label ladder):
 * - the toolbar is the same height idle, running and running with a draft, at 1000/760/560/420 px windows;
 * - the controls left of the send cluster (+, Run chip) never move on a turn starting, a draft being typed, or the
 *   turn ending, and Steer/Stop/Send keep their boxes (Stop left, Send right);
 * - an active mode paints the Run chip accent (computed colour, light and dark), a quiet chip does not;
 * - Tab leaves a popover: it closes and focus moves on (never to the top of the app);
 * - the context ring opens on click/Enter, never on keyboard focus.
 * With `OMP_GUI_TOOLBAR_CAPTURES=<dir>` (and OMP_GUI_VARIANTS=1 for en/ko × light/dark) it also writes
 * `toolbar-<viewport>-<theme>-<lang>-<state>.png` for 1280, 900 and 834.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { captureTo, exitApp, launchApp, variants } from "./harness";
import { resize } from "./shell-capture";

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.boundingBox();
	if (!box) throw new Error("no box");
	return {
		x: Math.round(box.x * 10) / 10,
		y: Math.round(box.y * 10) / 10,
		width: Math.round(box.width * 10) / 10,
		height: Math.round(box.height * 10) / 10,
	};
}

async function launch(language: string, theme: string) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-composer-toolbar-")));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(root, name));
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language, themeName: theme, firstRunComplete: true, workBoard: false }),
	);
	const app = await launchApp({ project, desktop, agent, profile: root });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, root };
}

const toolbar = (page: Page) => page.getByRole("toolbar").first();
const runChip = (page: Page) => page.locator("[data-run-settings-trigger]").first();
const field = (page: Page) => page.locator(".omp-composer-input").first();
const slot = (page: Page, name: string) => page.locator(`[data-slot="${name}"]`).first();

/** Start a turn that keeps running (the fake omp's "fixture running"). */
async function startTurn(page: Page): Promise<void> {
	await field(page).fill("fixture running");
	await field(page).press("Enter");
	await expect(slot(page, "stop")).not.toHaveAttribute("data-off", "");
}

async function stopTurn(page: Page): Promise<void> {
	await slot(page, "stop").getByRole("button").click();
	await expect(slot(page, "stop")).toHaveAttribute("data-off", "");
}

async function snapshot(page: Page) {
	return {
		toolbar: await boxOf(toolbar(page)),
		plus: await boxOf(toolbar(page).getByRole("button").first()),
		run: await boxOf(runChip(page)),
		steer: await boxOf(slot(page, "steer")),
		stop: await boxOf(slot(page, "stop")),
		send: await boxOf(slot(page, "send")),
	};
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`toolbar: same height and no shift on turn start, draft and end; accent; Tab out; context (${language} ${theme})`, async () => {
			test.setTimeout(240_000);
			const { app, page, root } = await launch(language, theme);
			const captures = process.env.OMP_GUI_TOOLBAR_CAPTURES;
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			try {
				for (const width of [1000, 760, 560, 420]) {
					await resize(app, width, 800);
					await page.waitForTimeout(300);
					const idle = await snapshot(page);
					await startTurn(page);
					const running = await snapshot(page);
					await field(page).fill("steer this");
					const draft = await snapshot(page);
					await field(page).fill("");
					await stopTurn(page);
					const ended = await snapshot(page);
					for (const [name, state] of [
						["running", running],
						["draft", draft],
						["ended", ended],
					] as const) {
						expect(state.toolbar.height, `${width}px ${name}: toolbar height`).toBe(idle.toolbar.height);
						for (const key of ["plus", "run", "steer", "stop", "send"] as const) {
							expect(state[key].x, `${width}px ${name}: ${key} x`).toBeCloseTo(idle[key].x, 0);
							expect(state[key].y, `${width}px ${name}: ${key} y`).toBeCloseTo(idle[key].y, 0);
						}
					}
					// Stop sits left of Send in its own box.
					expect(idle.stop.x + idle.stop.width).toBeLessThanOrEqual(idle.send.x + 1);
					// Nothing leaves the composer box.
					const edge = await page.evaluate(() => {
						const box = document.querySelector(".omp-composer-box")?.getBoundingClientRect();
						const send = document.querySelector('[data-slot="send"]')?.getBoundingClientRect();
						return box && send ? box.right - send.right : null;
					});
					expect(edge, `${width}px: Send inside the composer`).toBeGreaterThanOrEqual(0);
				}

				// A quiet chip is not accent; a Plan mode is, in the real computed colour.
				await resize(app, 1280, 860);
				await page.waitForTimeout(300);
				const colour = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).color);
				const accent = await page.evaluate(() => {
					const probe = document.createElement("span");
					probe.style.color = "var(--sc-accent)";
					document.body.appendChild(probe);
					const value = getComputedStyle(probe).color;
					probe.remove();
					return value;
				});
				expect(await colour(runChip(page))).not.toBe(accent);
				await captureTo(captures, page, `toolbar-1280-${theme}-${language}-idle`);
				await runChip(page).click();
				await page.locator("[data-plan-mode]").click();
				await expect(runChip(page)).toHaveAttribute("data-active", "");
				await page.keyboard.press("Escape");
				await expect(page.locator("[data-composer-modes-section]")).toHaveCount(0);
				// The chip eases its colour over a few ms: poll to the settled value.
				await expect.poll(() => colour(runChip(page))).toBe(accent);
				await captureTo(captures, page, `toolbar-1280-${theme}-${language}-plan-goal`);

				// Tab leaves the popover and closes it; focus does not jump to the top of the app.
				await runChip(page).click();
				const popover = page
					.locator('[role="dialog"]')
					.filter({ has: page.locator("[data-composer-modes-section]") });
				await expect(popover).toBeVisible();
				await captureTo(captures, page, `toolbar-1280-${theme}-${language}-popover-open`);
				await popover.evaluate(panel => {
					const stops = panel.querySelectorAll<HTMLElement>(
						"button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])",
					);
					stops[stops.length - 1]?.focus();
				});
				await page.keyboard.press("Tab");
				await expect(popover).toHaveCount(0);
				const where = await page.evaluate(() => {
					const active = document.activeElement;
					return { inToolbar: !!active?.closest('[role="toolbar"]'), tag: active?.tagName };
				});
				expect(where.inToolbar, `focus after Tab out: ${where.tag}`).toBe(true);
				// Escape after the popover reopened returns to its anchor.
				await runChip(page).click();
				await expect(popover).toBeVisible();
				await page.keyboard.press("Tab");
				await page.keyboard.press("Escape");
				await expect(popover).toHaveCount(0);
				await runChip(page).click();
				await page.locator("[data-plan-mode]").click();
				await page.keyboard.press("Escape");

				// The context ring: focus alone never opens it; Enter does.
				const ring = page.locator(".omp-context-usage-trigger").first();
				if ((await ring.count()) > 0) {
					await ring.focus();
					await expect(ring).toHaveAttribute("aria-expanded", "false");
					await page.keyboard.press("Enter");
					await expect(ring).toHaveAttribute("aria-expanded", "true");
					await page.keyboard.press("Escape");
					await expect(ring).toHaveAttribute("aria-expanded", "false");
				}

				// After-captures for the states the sheet asks for, at the three viewports.
				for (const width of [1280, 900, 834]) {
					await resize(app, width, 860);
					await page.waitForTimeout(300);
					await captureTo(captures, page, `toolbar-${width}-${theme}-${language}-plan-goal`);
					await startTurn(page);
					await captureTo(captures, page, `toolbar-${width}-${theme}-${language}-running`);
					await field(page).fill("steer this");
					await captureTo(captures, page, `toolbar-${width}-${theme}-${language}-running-draft`);
					await field(page).fill("");
					await stopTurn(page);
					await runChip(page).click();
					await captureTo(captures, page, `toolbar-${width}-${theme}-${language}-popover-open`);
					await page.keyboard.press("Escape");
				}
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
