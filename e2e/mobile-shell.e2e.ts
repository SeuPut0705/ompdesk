import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import {
	type Browser,
	type BrowserType,
	chromium,
	devices,
	expect,
	type Locator,
	type Page,
	test,
	webkit,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { hitSizes, variants } from "./harness";

// The mobile shell (design §6) in Chromium and WebKit device emulation, on the dev harness: the renderer in a
// browser over a fixture transport (src/renderer/dev-harness), served by Vite from vite.harness.config.ts. Each
// device checks the layout its mode promises (drawer / sheet / dock), the sheet and dialog behaviours, long
// press, and the system back gesture; OMP_GUI_MOBILE_SHELL=<dir> also writes the light/dark × en/ko captures.
// The Electron desktop's own layout is covered by the existing desktop specs, which this file does not touch.

const captures = process.env.OMP_GUI_MOBILE_SHELL;

// A cold Vite dev server can reload once while it optimizes dependencies; a second try is that, not a flake of the shell.
test.describe.configure({ retries: 1 });

type Shell = "phone" | "tablet-portrait" | "tablet-landscape";

// `drawer`: the session list waits behind a menu button. A portrait tablet from 800 px (the iPad Pro 11's 834)
// docks it as a second pane beside the transcript, as the landscape one does.
const DEVICES: ReadonlyArray<{ name: string; shell: Shell; drawer: boolean }> = [
	{ name: "iPhone 15", shell: "phone", drawer: true },
	{ name: "Pixel 8", shell: "phone", drawer: true },
	{ name: "iPad Pro 11", shell: "tablet-portrait", drawer: false },
	{ name: "iPad Pro 11 landscape", shell: "tablet-landscape", drawer: false },
];

const ENGINES: ReadonlyArray<{ name: string; type: BrowserType }> = [
	{ name: "chromium", type: chromium },
	{ name: "webkit", type: webkit },
];

let server: ViteDevServer | undefined;
let origin = "";

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
});

test.afterAll(async () => {
	await server?.close();
});

interface Look {
	theme: "light" | "dark";
	lang: "en" | "ko";
}

async function openHarness(
	browser: Browser,
	device: string,
	look: Look,
	options: { landscape?: boolean } = {},
): Promise<Page> {
	const preset = devices[device];
	if (!preset) throw new Error(`unknown device ${device}`);
	const context = await browser.newContext(
		options.landscape
			? {
					...preset,
					viewport: { width: preset.viewport.height, height: preset.viewport.width },
				}
			: { ...preset },
	);
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${look.theme}&lang=${look.lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	return page;
}

interface Insets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/**
 * Gives the page the system insets of a notched phone: Chromium through CDP (`env(safe-area-inset-*)` itself),
 * WebKit (which has no such override) and a Chromium without the CDP method through the `--safe-*` tokens
 * mobile.css derives from `env()`. Returns what the page's `--safe-b` resolves to, so a test can see it took.
 */
async function emulateInsets(page: Page, engine: string, insets: Insets): Promise<void> {
	const probe = () =>
		page.evaluate(() => {
			const el = document.createElement("div");
			el.style.cssText =
				"position:fixed;visibility:hidden;padding:var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l)";
			document.body.append(el);
			const style = getComputedStyle(el);
			const read = {
				top: Number.parseFloat(style.paddingTop),
				right: Number.parseFloat(style.paddingRight),
				bottom: Number.parseFloat(style.paddingBottom),
				left: Number.parseFloat(style.paddingLeft),
			};
			el.remove();
			return read;
		});
	if (engine === "chromium") {
		try {
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets } as never);
		} catch {
			// An older Chromium: the token override below takes over.
		}
	}
	if ((await probe()).bottom !== insets.bottom) {
		await page.addStyleTag({
			content: `:root { --safe-t: ${insets.top}px; --safe-r: ${insets.right}px; --safe-b: ${insets.bottom}px; --safe-l: ${insets.left}px; }`,
		});
	}
	expect(await probe()).toEqual(insets);
}

const menuButton = (page: Page): Locator => page.locator("header button:has(svg.lucide-menu)");
const panelButton = (page: Page): Locator => page.locator('[data-tour="panel"]');
const drawer = (page: Page): Locator => page.locator("[data-drawer]");

/** A finger on `target` that stays down, as the browser's pointer events report it. */
async function touchDown(target: Locator): Promise<void> {
	await target.evaluate(element => {
		const box = element.getBoundingClientRect();
		element.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				clientX: box.left + box.width / 2,
				clientY: box.top + box.height / 2,
				isPrimary: true,
				pointerId: 11,
				pointerType: "touch",
			}),
		);
	});
}

async function touchUp(target: Locator): Promise<void> {
	await target.evaluate(element => {
		element.dispatchEvent(
			new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerId: 11, pointerType: "touch" }),
		);
	});
}

/** A box once its entrance animation is over: two reads 60 ms apart agree. */
async function settledBox(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
	let previous = await target.boundingBox();
	for (let attempt = 0; attempt < 30; attempt++) {
		await target.page().waitForTimeout(60);
		const next = await target.boundingBox();
		if (
			next &&
			previous &&
			next.x === previous.x &&
			next.y === previous.y &&
			next.width === previous.width &&
			next.height === previous.height
		)
			return next;
		previous = next;
	}
	throw new Error("the element never settled");
}

async function capture(page: Page, name: string, tag: string): Promise<void> {
	if (!captures) return;
	await fs.mkdir(captures, { recursive: true });
	await page.waitForTimeout(450);
	await page.screenshot({ path: path.join(captures, `${tag}-${name}.png`), animations: "disabled" });
}

// The default run keeps each shell mode once in Chromium plus WebKit on a phone; the other engine × device
// pairs repeat a mode and run with OMP_GUI_VARIANTS=1.
for (const { engine, device } of variants(
	ENGINES.flatMap(engine => DEVICES.map(device => ({ engine, device }))),
	({ engine, device }) => (engine.name === "chromium" ? device.name !== "Pixel 8" : device.name === "iPhone 15"),
)) {
	test.describe(`${engine.name} · ${device.name}`, () => {
		let browser: Browser;
		const drawerMode = device.drawer;

		test.beforeAll(async () => {
			browser = await engine.type.launch();
		});
		test.afterAll(async () => {
			await browser.close();
		});

		test("the page is in the shell mode its size gives, with touch input", async () => {
			const page = await openHarness(browser, device.name, { theme: "light", lang: "en" });
			const root = page.locator("html");
			await expect(root).toHaveAttribute("data-platform", "web");
			await expect(root).toHaveAttribute("data-shell", device.shell);
			await expect(root).toHaveAttribute("data-input", "touch");
			// Touch targets: the title bar's buttons are dense to look at (the icon ones 36 px or less across) and
			// reach 44 px through their invisible hit area.
			const bar = await hitSizes(page.locator("header button"));
			expect(Math.min(...bar.map(({ hit }) => Math.min(hit.width, hit.height)))).toBeGreaterThanOrEqual(44);
			expect(Math.min(...bar.map(({ visual }) => Math.min(visual.width, visual.height)))).toBeLessThanOrEqual(36);
			// The composer's field never zooms iOS: 16 px or more.
			const fontSize = await page
				.locator("textarea")
				.first()
				.evaluate(field => Number.parseFloat(getComputedStyle(field).fontSize));
			expect(fontSize).toBeGreaterThanOrEqual(16);
			expect(
				await page.evaluate(() => window.__harness?.unhandled.filter(key => key.startsWith("runtime:"))),
			).toEqual([]);
			await page.context().close();
		});

		test("the sidebar is a drawer on a phone, docked beside the transcript on a tablet", async () => {
			const page = await openHarness(browser, device.name, { theme: "light", lang: "en" });
			if (!drawerMode) {
				await expect(page.locator(".omp-session-sidebar")).toBeVisible();
				await expect(menuButton(page)).toHaveCount(0);
				await expect(drawer(page)).toHaveCount(0);
				await page.context().close();
				return;
			}
			await expect(drawer(page)).toHaveCount(0);
			await menuButton(page).click();
			await expect(drawer(page).locator(".omp-session-sidebar")).toBeVisible();
			// The system back gesture closes it instead of leaving the page.
			const url = page.url();
			await page.goBack();
			await expect(drawer(page)).toHaveCount(0);
			expect(page.url()).toBe(url);
			// The scrim closes it too, and choosing another session does.
			await menuButton(page).click();
			await expect(drawer(page)).toBeVisible();
			await drawer(page).click({ position: { x: device.shell === "phone" ? 380 : 800, y: 300 } });
			await expect(drawer(page)).toHaveCount(0);
			await menuButton(page).click();
			await drawer(page).getByText("Add dark mode to the settings page").first().click();
			await expect(drawer(page)).toHaveCount(0);
			await expect(page.locator("[data-titlebar-session-name]")).toContainText("Add dark mode");
			await page.context().close();
		});

		test("the side panel is a full-screen sheet with a tab bar, a right sheet, or docked", async () => {
			const page = await openHarness(browser, device.name, { theme: "light", lang: "en" });
			await panelButton(page).click();
			if (device.shell === "phone") {
				const sheet = page.locator('[data-sheet-placement="full"] [data-sheet-panel]');
				await expect(sheet).toBeVisible();
				await expect(page.locator("[data-panel-tabbar] button")).toHaveCount(5);
				const box = await settledBox(sheet);
				const viewport = page.viewportSize();
				expect(box.width).toBeCloseTo(viewport?.width ?? 0, 0);
				expect(box.height).toBeCloseTo(viewport?.height ?? 0, 0);
				// The handle pulls it away.
				const handle = sheet.locator("[data-sheet-handle]");
				const grip = await settledBox(handle);
				if (!grip) throw new Error("no sheet handle");
				await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
				await page.mouse.down();
				await page.mouse.move(grip.x + grip.width / 2, grip.y + 220, { steps: 6 });
				await page.mouse.up();
				await expect(page.locator("[data-sheet-placement]")).toHaveCount(0);
			} else if (device.shell === "tablet-portrait") {
				const sheet = page.locator('[data-sheet-placement="right"] [data-sheet-panel]');
				await expect(sheet).toBeVisible();
				const box = await settledBox(sheet);
				expect(box?.width).toBeLessThanOrEqual(560);
				expect(box?.width).toBeGreaterThan(400);
			} else {
				await expect(page.locator('aside[data-docked="docked"]')).toBeVisible();
				await expect(page.locator("[data-sheet-placement]")).toHaveCount(0);
			}
			await page.context().close();
		});

		test("the work board is a chip and a sheet where it cannot dock", async () => {
			const page = await openHarness(browser, device.name, { theme: "light", lang: "en" });
			const chip = page.locator("[data-work-chip]");
			if (device.shell === "tablet-landscape") {
				await expect(chip).toHaveCount(0);
				await page.context().close();
				return;
			}
			await expect(chip).toBeVisible();
			await chip.click();
			const sheet = page.locator('[data-sheet-placement="bottom"] [data-sheet-panel]');
			await expect(sheet).toBeVisible();
			await expect(sheet.locator("[data-board-turn], [data-todo-status]").first()).toBeVisible();
			await page.goBack();
			await expect(sheet).toHaveCount(0);
			await page.context().close();
		});

		test("dialogs are bottom sheets on a phone and centered elsewhere", async () => {
			const page = await openHarness(browser, device.name, { theme: "light", lang: "en" });
			if (drawerMode) await menuButton(page).click();
			await page.locator("[data-command-center-entry]").click();
			const dialog = page.locator('[role="dialog"]').first();
			await expect(dialog).toBeVisible();
			const box = await settledBox(dialog);
			const viewport = page.viewportSize();
			if (!box || !viewport) throw new Error("no geometry");
			if (device.shell === "phone") {
				await expect(dialog).toHaveAttribute("data-presentation", "sheet");
				expect(box.width).toBe(viewport.width);
				expect(Math.round(box.y + box.height)).toBe(viewport.height);
				await expect(dialog.locator("[data-sheet-handle]")).toBeVisible();
			} else {
				await expect(dialog).not.toHaveAttribute("data-presentation", "sheet");
				expect(box.width).toBeLessThan(viewport.width);
				expect(box.y + box.height).toBeLessThan(viewport.height);
			}
			// Back closes the dialog on the web shell.
			await page.goBack();
			await expect(page.locator('[role="dialog"]')).toHaveCount(0);
			await page.context().close();
		});

		test("a session row's rename and delete collapse into one ⋯ button that opens the action sheet", async () => {
			const page = await openHarness(browser, device.name, { theme: "light", lang: "en" });
			if (drawerMode) await menuButton(page).click();
			const sidebar = page.locator(".omp-session-sidebar");
			const current = sidebar.locator('[data-session-path][data-active="true"]').first();
			await expect(current).toBeVisible();
			// The open row would otherwise show rename and delete for good (touch has no hover to hide them).
			await expect(current.locator("[data-sidebar-row-menu]")).toHaveCount(1);
			await expect(
				sidebar.locator('button[aria-label="Rename session"], button[aria-label="Delete session"]'),
			).toHaveCount(0);
			// Every row carries one (a finger has no hover): a small glyph with a 44 px hit area that leaves the title its width.
			const menus = sidebar.locator("[data-sidebar-row-menu]");
			expect(await menus.count()).toBe(
				await sidebar.locator("[data-session-path]:not([data-session-path^='tab:'])").count(),
			);
			for (const { visual, hit } of await hitSizes(menus)) {
				expect(Math.min(hit.width, hit.height)).toBeGreaterThanOrEqual(44);
				expect(Math.max(visual.width, visual.height)).toBeLessThanOrEqual(36);
			}
			await capture(page, "row-menu", `${engine.name}-${device.name.replace(/ /g, "-")}-light-en`);
			await current.locator("[data-sidebar-row-menu]").click();
			const menu = page.locator("[data-action-sheet] [role='menu']");
			await expect(menu).toBeVisible({ timeout: 3000 });
			await expect(menu.getByRole("menuitem", { name: "Rename session" })).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.locator("[data-action-sheet]")).toHaveCount(0);
			await page.context().close();
		});

		test("a long press opens an action sheet, and a long press on a button shows its tooltip without a click", async () => {
			const page = await openHarness(browser, device.name, { theme: "light", lang: "en" });
			if (drawerMode) await menuButton(page).click();
			const row = page.locator(".omp-session-sidebar").getByText("Add dark mode to the settings").first();
			await touchDown(row);
			await expect(page.locator("[data-action-sheet] [role='menu']")).toBeVisible({ timeout: 3000 });
			await touchUp(row);
			await page.keyboard.press("Escape");
			await expect(page.locator("[data-action-sheet]")).toHaveCount(0);
			if (drawerMode) await page.goBack().catch(() => {});

			if (drawerMode) await expect(drawer(page)).toHaveCount(0);
			const button = panelButton(page);
			await touchDown(button);
			await expect(page.getByRole("tooltip").filter({ hasText: /Side panel|사이드 패널/ })).toBeVisible({
				timeout: 3000,
			});
			await touchUp(button);
			// The click that ends the long press is swallowed: the panel stays shut.
			await button.dispatchEvent("click");
			await page.waitForTimeout(400);
			await expect(
				page.locator('[data-sheet-placement="full"], [data-sheet-placement="right"], aside[data-docked]'),
			).toHaveCount(0);
			await page.context().close();
		});

		// Bottom-anchored UI sits above the system UI: a gesture bar / home indicator (portrait) and the notch
		// and gesture insets on the sides (landscape), with the keyboard closed and open. The insets are emulated
		// (CDP `Emulation.setSafeAreaInsetsOverride`, else the `--safe-*` tokens), and the page is resized the way
		// a retracting browser toolbar resizes the dynamic viewport.
		for (const theme of ["light", "dark"] as const) {
			for (const landscape of device.shell === "phone" ? [false, true] : []) {
				test(`the composer clears the system insets: ${theme}, ${landscape ? "landscape" : "portrait"}`, async () => {
					const page = await openHarness(browser, device.name, { theme, lang: "en" }, { landscape });
					const insets: Insets = landscape
						? { top: 0, right: 47, bottom: 21, left: 47 }
						: { top: 47, right: 0, bottom: 34, left: 0 };
					await emulateInsets(page, engine.name, insets);
					const shell = page.locator(".omp-composer-region .omp-composer-shell").first();
					await expect(shell).toBeVisible();
					const tag = `${engine.name}-${device.name.replace(/ /g, "-")}-${theme}-${landscape ? "landscape" : "portrait"}`;

					const measure = () =>
						page.evaluate(() => {
							const box = document
								.querySelector(".omp-composer-region .omp-composer-shell")
								?.getBoundingClientRect();
							const root = document.querySelector(".omp-app-root")?.getBoundingClientRect();
							const body = document.body.getBoundingClientRect();
							return {
								width: window.innerWidth,
								height: window.innerHeight,
								shell: box && { left: box.left, right: box.right, bottom: box.bottom },
								root: root && { width: root.width, height: root.height },
								body: { width: body.width, height: body.height },
							};
						});

					// Keyboard closed: the app fills the body (never the large viewport), the composer ends above the inset.
					let seen = await measure();
					expect(seen.root?.height).toBeCloseTo(seen.body.height, 0);
					expect(seen.root?.width).toBeCloseTo(seen.body.width - insets.left - insets.right, 0);
					expect(seen.shell?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(seen.height - insets.bottom);
					expect(seen.shell?.left ?? 0).toBeGreaterThanOrEqual(insets.left);
					expect(seen.shell?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(seen.width - insets.right);
					await capture(page, "safe-area", tag);

					// A dynamic viewport: the browser toolbar returns and the window gets shorter; the composer follows it.
					const full = page.viewportSize();
					if (!full) throw new Error("no viewport");
					await page.setViewportSize({ width: full.width, height: full.height - 56 });
					await expect.poll(async () => (await measure()).height).toBe(full.height - 56);
					seen = await measure();
					expect(seen.root?.height).toBeCloseTo(seen.body.height, 0);
					expect(seen.shell?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(seen.height - insets.bottom);
					await page.setViewportSize(full);

					// Keyboard open (what lib/keyboard-inset.ts writes): the composer rides on top of the keyboard.
					const keyboard = landscape ? 120 : 300;
					await page.evaluate(px => {
						document.documentElement.style.setProperty("--kb-inset", `${px}px`);
						document.documentElement.dataset.kb = "open";
					}, keyboard);
					await expect
						.poll(async () => Math.round((await measure()).root?.height ?? 0))
						.toBe(full.height - keyboard);
					seen = await measure();
					expect(seen.root?.height).toBeCloseTo(full.height - keyboard, 0);
					expect(seen.shell?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(seen.height - keyboard);
					await capture(page, "safe-area-keyboard", tag);
					await page.context().close();
				});
			}
		}

		// Registered only with OMP_GUI_MOBILE_SHELL=<dir>: a capture asserts nothing the tests above do not.
		for (const theme of captures ? (["light", "dark"] as const) : []) {
			for (const lang of ["en", "ko"] as const) {
				test(`captures: ${theme} ${lang}`, async () => {
					const page = await openHarness(browser, device.name, { theme, lang });
					const tag = `${engine.name}-${device.name.replace(/ /g, "-")}-${theme}-${lang}`;
					await capture(page, "session", tag);
					if (drawerMode) {
						await menuButton(page).click();
						await capture(page, "drawer", tag);
						await page.goBack();
						await expect(drawer(page)).toHaveCount(0);
					}
					if (device.shell !== "tablet-landscape") {
						await page.locator("[data-work-chip]").click();
						await capture(page, "board", tag);
						await page.goBack();
					}
					await panelButton(page).click();
					await capture(page, "panel", tag);
					await page.context().close();
				});
			}
		}
	});
}
