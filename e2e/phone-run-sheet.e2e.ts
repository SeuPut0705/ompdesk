import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Locator, type Page, test, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

/**
 * The phone's Run settings sheet and the composer row above it, on the dev harness (Pixel 8 emulation, touch input,
 * 360 / 390 / 412 px): every row of the sheet is ONE line (label + control, the explanation behind an (i) glyph, no
 * paragraph), small switches sit two to a row as icon tiles, the segmented choices are one row, and nothing of the
 * controls row runs under Stop/Send. Every composer sheet scrolls in ONE container with no drawn scrollbar track
 * (Chromium Pixel 8 and WebKit iPhone 15). OMP_GUI_RUN_SHEET=<dir> writes `<state>-<width>-<theme>-<lang>.png` captures.
 */

const captures = process.env.OMP_GUI_RUN_SHEET;

type Lang = "en" | "ko";
type Theme = "light" | "dark";

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser | undefined;
let webkitBrowser: Browser | undefined;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		const port = typeof address === "object" && address ? address.port : 0;
		probe.close(() => resolve(port));
	});
	return promise;
}

test.beforeAll(async () => {
	const port = await freePort();
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	origin = `http://127.0.0.1:${port}`;
	browser = await chromium.launch();
});

test.afterAll(async () => {
	await browser?.close();
	await webkitBrowser?.close();
	await server?.close();
});

interface PhoneOptions {
	lang?: Lang;
	theme?: Theme;
	width?: number;
	height?: number;
	engine?: "pixel8" | "webkit";
}

/** A phone on the harness with the composer idle and a model that offers every speed tier. */
async function openPhone(options: PhoneOptions = {}): Promise<Page> {
	const { lang = "ko", theme = "dark", width = 390, height = 844, engine = "pixel8" } = options;
	if (engine === "webkit") webkitBrowser ??= await webkit.launch();
	const target = engine === "webkit" ? webkitBrowser : browser;
	if (!target) throw new Error("no browser");
	const context = await target.newContext({
		...devices[engine === "webkit" ? "iPhone 15" : "Pixel 8"],
		viewport: { width, height },
		screen: { width, height },
	});
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 45_000 });
	await page.waitForFunction(() => window.__stores?.model !== undefined, undefined, { timeout: 45_000 });
	await expect(page.locator("html")).toHaveAttribute("data-shell", "phone");
	await page.evaluate(() => {
		window.__stores?.session.setState({ status: "ready", isStreaming: false });
		window.__stores?.model.setState({
			ultrafastSupported: true,
			slowModeSupported: true,
			slowModeScope: "session",
			fastModeEnabled: true,
		});
	});
	await expect(page.locator(".omp-composer-box")).toBeVisible();
	return page;
}

const runChip = (page: Page): Locator => page.locator(".omp-composer-box [data-run-settings-trigger]");
const sheetOf = (page: Page): Locator => page.getByRole("dialog", { name: /Run settings|실행 설정/ });

/** Waits for every animation under the locator (a sheet's slide-in) to finish: measured mid-animation, a sheet is below the screen. */
async function settled(locator: Locator): Promise<void> {
	await locator.evaluate(node =>
		Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished)),
	);
}

async function openRun(page: Page): Promise<Locator> {
	await runChip(page).tap();
	await expect(page.locator("[data-approval-mode]").first()).toBeVisible();
	const sheet = sheetOf(page);
	await settled(sheet);
	return sheet;
}

/** Advanced opens by itself while a value is not the default; open it otherwise, so every row of the sheet is on screen. */
async function openAdvanced(page: Page): Promise<void> {
	const advanced = sheetOf(page).locator("button[aria-expanded]", { hasText: /Advanced|고급/ });
	if ((await advanced.getAttribute("aria-expanded")) === "false") await advanced.tap();
	await expect(sheetOf(page).locator("[data-switch-tile]")).toHaveCount(9);
}

async function capture(page: Page, state: string, opts: PhoneOptions): Promise<void> {
	if (!captures) return;
	const { lang = "ko", theme = "dark", width = 390 } = opts;
	await fs.mkdir(captures, { recursive: true });
	await page.waitForTimeout(450);
	await page.screenshot({
		path: path.join(captures, `${state}-${width}-${theme}-${lang}.png`),
		animations: "disabled",
	});
}

async function captureSheet(page: Page, state: string, opts: PhoneOptions): Promise<void> {
	if (!captures) return;
	const { lang = "ko", theme = "dark", width = 390 } = opts;
	await fs.mkdir(captures, { recursive: true });
	await page.waitForTimeout(450);
	await sheetOf(page).screenshot({
		path: path.join(captures, `${state}-${width}-${theme}-${lang}.png`),
		animations: "disabled",
	});
}

const setRunning = (page: Page, running: boolean): Promise<void> =>
	page.evaluate(value => window.__stores?.session.setState({ isStreaming: value }), running);

/** Share of the control's drawn box (a 6x6 grid) that `elementFromPoint` resolves to the control itself. */
async function ownShare(locator: Locator): Promise<number> {
	return locator.first().evaluate(node => {
		const box = node.getBoundingClientRect();
		let own = 0;
		let total = 0;
		for (let row = 0; row < 6; row++) {
			for (let column = 0; column < 6; column++) {
				const x = box.left + ((column + 0.5) / 6) * box.width;
				const y = box.top + ((row + 0.5) / 6) * box.height;
				const hit = document.elementFromPoint(x, y);
				total++;
				if (hit && (hit === node || node.contains(hit))) own++;
			}
		}
		return own / total;
	});
}

/**
 * The composer's row: nothing of the sideways scroller reaches under Stop/Send (the reserved cluster outside it), every
 * control keeps its own taps, and the model chip ellipsizes inside its own box.
 */
async function expectRowClear(page: Page, what: string): Promise<void> {
	const geometry = await page.evaluate(() => {
		const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
		const scroller = document.querySelector(".omp-composer-scroll");
		const actions = rect(".omp-composer-actions");
		const scrollBox = scroller?.getBoundingClientRect();
		const label = document.querySelector(".omp-composer-model-label");
		return {
			scrollRight: scrollBox?.right ?? 0,
			actionsLeft: actions?.left ?? 0,
			overflow: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
			page: document.documentElement.scrollWidth - window.innerWidth,
			labelEllipsis: label ? getComputedStyle(label).textOverflow : null,
			labelShown: label ? getComputedStyle(label).display !== "none" : false,
			modelWidth: rect("[data-model-chip]")?.width ?? 0,
		};
	});
	expect(geometry.page, `${what}: page overflow`).toBeLessThanOrEqual(0);
	expect(geometry.scrollRight, `${what}: the scroller ends before Stop/Send`).toBeLessThanOrEqual(
		geometry.actionsLeft,
	);
	expect(geometry.modelWidth, `${what}: model chip`).toBeLessThanOrEqual(130);
	if (geometry.labelShown) expect(geometry.labelEllipsis, `${what}: model label`).toBe("ellipsis");
	for (const selector of [
		".omp-composer-scroll [aria-haspopup='menu']",
		"[data-run-settings-trigger]",
		"[data-chip=thinking]",
		"[data-chip=delegation]",
		"[data-model-chip]",
		"[data-slot=send] button",
	]) {
		expect(
			await ownShare(page.locator(`.omp-composer-box ${selector}`)),
			`${what}: ${selector} keeps its taps`,
		).toBeGreaterThan(0.9);
	}
}

const WIDTHS = [360, 390, 412] as const;

for (const width of WIDTHS) {
	for (const lang of ["ko", "en"] as const) {
		test(`the composer row keeps clear of Stop and Send · ${width} · ${lang}`, async () => {
			const page = await openPhone({ lang, width });
			try {
				await expectRowClear(page, "idle");
				// Idle (the common state) holds every control with no sideways scroll.
				expect(
					await page.evaluate(() => {
						const scroller = document.querySelector(".omp-composer-scroll");
						return scroller ? scroller.scrollWidth - scroller.clientWidth : 0;
					}),
					"idle row needs no scroll",
				).toBeLessThanOrEqual(width === 360 ? 8 : 1);
				await setRunning(page, true);
				await expect(page.locator("[data-slot=steer]")).not.toHaveAttribute("data-off", "");
				await expectRowClear(page, "running");
			} finally {
				await page.context().close();
			}
		});

		test(`the Run sheet is one line per row, tiles two to a row · ${width} · ${lang}`, async () => {
			const page = await openPhone({ lang, width, height: 1000 });
			try {
				const sheet = await openRun(page);
				await openAdvanced(page);
				const report = await sheet.evaluate(node => {
					const box = (element: Element) => element.getBoundingClientRect();
					const tiles = Array.from(node.querySelectorAll("[data-switch-tile]"));
					const rows = Array.from(node.querySelectorAll("[data-choice-row]"));
					return {
						overflow: node.scrollWidth - node.clientWidth,
						descriptions: node.querySelectorAll("[data-setting-desc]").length,
						paragraphs: node.querySelectorAll("p").length,
						tileLabels: tiles.map(tile => {
							const label = tile.querySelector("label span.truncate") as HTMLElement | null;
							return {
								text: label?.textContent ?? "",
								clipped: label ? label.scrollWidth > label.clientWidth + 1 : true,
								lines: label
									? Math.round(box(label).height / parseFloat(getComputedStyle(label).lineHeight))
									: 0,
							};
						}),
						tileTops: tiles.map(tile => Math.round(box(tile).top)),
						tileLefts: tiles.map(tile => Math.round(box(tile).left)),
						rowHeights: rows.map(row => Math.round(box(row).height)),
						pairs: Array.from(node.querySelectorAll("[data-switch-grid]")).map(grid => {
							const tops = Array.from(grid.querySelectorAll("[data-switch-tile]")).map(tile =>
								Math.round(box(tile).top),
							);
							return tops.length - new Set(tops).size;
						}),
					};
				});
				expect(report.overflow, "no sideways overflow").toBeLessThanOrEqual(0);
				expect(report.descriptions, "no visible description").toBe(0);
				expect(report.paragraphs, "no paragraph").toBe(0);
				for (const label of report.tileLabels) {
					expect(label.lines, `${label.text} stays on one line`).toBeLessThanOrEqual(1);
					// A tile label may truncate on the narrowest phone only where it is long; the short ones never.
					if (width >= 390) expect(label.clipped, `${label.text} is not cut at ${width}`).toBe(false);
				}
				// Two tiles share a row: Fast | Slow, and in Advanced the pairs.
				expect(
					report.pairs.every(shared => shared >= 1),
					"every grid pairs its tiles",
				).toBe(true);
				for (const height of report.rowHeights)
					expect(height, "a segmented row is one line").toBeLessThanOrEqual(56);
				// Taps: every switch and segment answers for itself (nothing steals its centre).
				for (const control of await sheet.locator("[role=switch], [data-choice-row] [role=radio]").all()) {
					expect(await ownShare(control), "a control keeps its own taps").toBeGreaterThan(0.85);
				}
				await captureSheet(page, "sheet-full", { lang, width });
			} finally {
				await page.context().close();
			}
		});
	}
}

for (const lang of ["ko", "en"] as const) {
	for (const theme of ["dark", "light"] as const) {
		test(`captures the composer and the Run sheet at 390 · ${theme} · ${lang}`, async () => {
			test.skip(!captures, "OMP_GUI_RUN_SHEET not set");
			const opts = { lang, theme };
			const page = await openPhone({ ...opts, height: 1000 });
			try {
				await page.setViewportSize({ width: 390, height: 844 });
				await capture(page, "composer", opts);
				await setRunning(page, true);
				await capture(page, "composer-running", opts);
				await setRunning(page, false);
				await openRun(page);
				await capture(page, "sheet", opts);
				// A taller screen shows the whole sheet; a resize closes it, so open it again.
				await page.keyboard.press("Escape");
				await expect(sheetOf(page)).toHaveCount(0);
				await page.setViewportSize({ width: 390, height: 1100 });
				await openRun(page);
				await openAdvanced(page);
				await captureSheet(page, "sheet-full", opts);
				for (const [id, name] of [
					["goal", /Goal|목표/],
					["autopilot", /Autopilot|오토파일럿/],
				] as const) {
					await page.getByRole("tab", { name }).tap();
					await captureSheet(page, `sheet-${id}`, opts);
				}
			} finally {
				await page.context().close();
			}
		});
	}
}

/**
 * Scroll containers of the open bottom sheet: elements that scroll vertically (`overflow-y` auto/scroll with more
 * content than room), and the width any of them draws for a scrollbar track. A sheet is ONE scroller, and on touch its
 * scrollbar is the platform's overlay (no custom `::-webkit-scrollbar` track taking width).
 */
async function sheetScrollers(page: Page): Promise<{ scrolling: string[]; trackWidths: number[] }> {
	return page.evaluate(() => {
		const sheet = document.querySelector('[data-action-sheet], [data-sheet-placement], [data-presentation="sheet"]');
		if (!sheet) return { scrolling: ["no sheet"], trackWidths: [] };
		const scrollers = [sheet, ...Array.from(sheet.querySelectorAll("*"))].filter(
			node => node instanceof HTMLElement && /auto|scroll/.test(getComputedStyle(node).overflowY),
		) as HTMLElement[];
		return {
			scrolling: scrollers
				.filter(node => node.scrollHeight > node.clientHeight)
				.map(node => `${node.tagName.toLowerCase()}.${node.className.split(" ").slice(0, 3).join(".")}`),
			trackWidths: scrollers.map(node => {
				const style = getComputedStyle(node);
				return (
					node.offsetWidth -
					node.clientWidth -
					parseFloat(style.borderLeftWidth) -
					parseFloat(style.borderRightWidth)
				);
			}),
		};
	});
}

/** A composer bottom sheet: an action sheet (`Popover`, `MenuButton`, `ComposerSheet` on a phone) or a dialog sheet. */
const SHEET = '[data-action-sheet], [data-sheet-placement], [data-presentation="sheet"]';

for (const engine of ["pixel8", "webkit"] as const) {
	test(`every composer sheet scrolls in one container with no drawn track · ${engine}`, async () => {
		const page = await openPhone({ engine });
		try {
			// The Run sheet is taller than 844 px of phone: the sheet itself scrolls, nothing inside it does.
			await openRun(page);
			await openAdvanced(page);
			const run = await sheetScrollers(page);
			expect(run.scrolling, "the Run sheet has exactly one scroller").toHaveLength(1);
			expect(
				run.trackWidths.every(width => width === 0),
				"no scrollbar track takes width on touch",
			).toBe(true);
			await page.keyboard.press("Escape");
			await expect(page.locator(SHEET)).toHaveCount(0);
			for (const chip of [
				"[data-chip=thinking]",
				"[data-chip=delegation]",
				"[data-chip=context]",
				"[data-model-chip]",
				'button[aria-label="첨부 및 더 보기"]',
			]) {
				const trigger = page.locator(`.omp-composer-box ${chip}`).first();
				await expect(trigger, `${chip} is in the composer`).toBeVisible();
				await trigger.tap();
				await expect(page.locator(SHEET), `${chip} opens a sheet`).toHaveCount(1);
				await settled(page.locator(SHEET));
				const sheet = await sheetScrollers(page);
				expect(
					sheet.scrolling.length,
					`${chip} sheet: at most one scroller (${sheet.scrolling})`,
				).toBeLessThanOrEqual(1);
				expect(
					sheet.trackWidths.every(width => width === 0),
					`${chip} sheet draws no track`,
				).toBe(true);
				await page.keyboard.press("Escape");
				await expect(page.locator(SHEET)).toHaveCount(0);
			}
			// A long queue: its list (capped at 18 rem on the desktop) is part of the sheet's one scroll on a phone.
			await page.evaluate(() => {
				const items = Array.from({ length: 28 }, (_, index) => ({
					id: `q${index}`,
					text: `대기 중인 메시지 ${index}`,
				}));
				window.__stores?.session.setState({ isStreaming: true });
				window.__stores?.queue.setState({
					steering: items.slice(0, 14),
					followUp: items.slice(14),
					refresh: async () => {},
				});
			});
			await page.locator("[data-queue-pill]").tap();
			await expect(page.locator(SHEET), "the queue pill opens a sheet").toHaveCount(1);
			await settled(page.locator(SHEET));
			const queue = await sheetScrollers(page);
			expect(queue.scrolling, "the queue sheet has exactly one scroller").toHaveLength(1);
			expect(
				queue.trackWidths.every(width => width === 0),
				"the queue sheet draws no track",
			).toBe(true);
		} finally {
			await page.context().close();
		}
	});
}

/** The desktop popover is the same one-line rows at its own width. */
for (const lang of ["ko", "en"] as const) {
	for (const theme of ["dark", "light"] as const) {
		test(`the desktop popover has the same one-line rows · ${theme} · ${lang}`, async () => {
			if (!browser) throw new Error("no browser");
			const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const page = await context.newPage();
			page.on("pageerror", error => {
				throw error;
			});
			try {
				await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
				await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 45_000 });
				await page.waitForFunction(() => window.__stores?.model !== undefined, undefined, { timeout: 45_000 });
				await page.evaluate(() => {
					window.__stores?.session.setState({ status: "ready", isStreaming: false });
					window.__stores?.model.setState({
						ultrafastSupported: true,
						slowModeSupported: true,
						fastModeEnabled: true,
					});
				});
				await page.locator(".omp-composer-box [data-run-settings-trigger]").click();
				const popover = sheetOf(page);
				await expect(popover).toBeVisible();
				await openAdvanced(page);
				await expect(popover.locator("[data-setting-desc]")).toHaveCount(0);
				await expect(popover.locator("p")).toHaveCount(0);
				await expect(popover.locator("[data-choice-row]")).toHaveCount(3);
				const widths = await popover.evaluate(node => ({
					width: node.getBoundingClientRect().width,
					overflow: node.scrollWidth - node.clientWidth,
				}));
				expect(widths.width, "the popover keeps its width").toBeLessThanOrEqual(384.5);
				expect(widths.overflow).toBeLessThanOrEqual(0);
				const clipped = await popover.evaluate(node =>
					Array.from(node.querySelectorAll<HTMLElement>("[data-switch-tile] label span.truncate"))
						.filter(label => label.scrollWidth > label.clientWidth + 1)
						.map(label => label.textContent),
				);
				expect(clipped, "no tile label is cut at the popover's width").toEqual([]);
				if (captures) {
					await fs.mkdir(captures, { recursive: true });
					await popover.screenshot({ path: path.join(captures, `popover-desktop-${theme}-${lang}.png`) });
				}
			} finally {
				await context.close();
			}
		});
	}
}
