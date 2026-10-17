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
import { variants } from "./harness";

// Settings, the centers and the model picker on a phone and a portrait tablet (mobile web, design §6/§9 W-F) in
// Chromium and WebKit device emulation, on the dev harness (src/renderer/dev-harness): a phone pushes Settings'
// section list and a center's list to a detail page under a back button (the system back gesture does the same),
// a portrait tablet keeps both columns; the model picker is a full-height sheet with its search pinned; nothing
// runs wider than the screen and every touch target is at least 44 px. OMP_GUI_MOBILE_PAGES=<dir> also writes the
// light/dark × en/ko captures.

const captures = process.env.OMP_GUI_MOBILE_PAGES;

// A cold Vite dev server can reload once while it optimizes dependencies; a second try is that, not a flake.
test.describe.configure({ retries: 1 });

interface Device {
	name: string;
	phone: boolean;
	options: Parameters<Browser["newContext"]>[0];
}

const DEVICES: readonly Device[] = [
	{ name: "iPhone 15", phone: true, options: { ...devices["iPhone 15"], viewport: { width: 390, height: 844 } } },
	{ name: "small phone", phone: true, options: { ...devices["iPhone 15"], viewport: { width: 360, height: 740 } } },
	{
		name: "tablet portrait",
		phone: false,
		options: { ...devices["iPad Pro 11"], viewport: { width: 820, height: 1180 } },
	},
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

const LIGHT_EN: Look = { theme: "light", lang: "en" };

async function openHarness(browser: Browser, device: Device, look: Look, extra = ""): Promise<Page> {
	const context = await browser.newContext(device.options);
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	// `rail=all` pins Agents and Stats under the session list, so the drawer reaches every page.
	await page.goto(`${origin}/harness.html?theme=${look.theme}&lang=${look.lang}&rail=all${extra}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	return page;
}

const menuButton = (page: Page): Locator => page.locator("button:visible:has(svg.lucide-menu)").first();
const drawer = (page: Page): Locator => page.locator("[data-drawer]");

/** A destination page (Settings, Agents, Insights) through the drawer's footer. */
async function openDestination(page: Page, id: "settings" | "agents" | "insights"): Promise<void> {
	await menuButton(page).click();
	const target = drawer(page).locator(`[data-destination="${id}"]`);
	await settled(target);
	await target.click();
	await expect(drawer(page)).toHaveCount(0);
}

/** A box once its entrance animation is over: two reads 80 ms apart agree. */
async function settled(target: Locator): Promise<{ x: number; y: number; width: number; height: number } | null> {
	let previous = await target.boundingBox();
	for (let attempt = 0; attempt < 40; attempt++) {
		await target.page().waitForTimeout(80);
		const next = await target.boundingBox();
		if (
			previous &&
			next &&
			previous.x === next.x &&
			previous.y === next.y &&
			previous.width === next.width &&
			previous.height === next.height
		)
			return next;
		previous = next;
	}
	return previous;
}

async function capture(page: Page, name: string, tag: string): Promise<void> {
	if (!captures) return;
	await fs.mkdir(captures, { recursive: true });
	await page.waitForTimeout(450);
	await page.screenshot({ path: path.join(captures, `${tag}-${name}.png`), animations: "disabled" });
}

const tagOf = (engine: string, device: Device, look: Look): string =>
	`${engine}-${device.name.replace(/ /g, "-")}-${look.theme}-${look.lang}`;

/** What runs past the right edge of the screen inside `root`: the document's own overflow and the first culprits. */
async function overflow(page: Page, root: string): Promise<{ document: number; offenders: string[] }> {
	return page.evaluate(selector => {
		const width = window.innerWidth;
		const top = document.querySelector(selector);
		const clipped = (element: Element): boolean => {
			for (let node = element.parentElement; node && node !== top?.parentElement; node = node.parentElement) {
				const overflowX = getComputedStyle(node).overflowX;
				if (overflowX !== "visible" && node.getBoundingClientRect().right <= width + 1) return true;
			}
			return false;
		};
		const offenders: string[] = [];
		for (const element of top?.querySelectorAll("*") ?? []) {
			const box = element.getBoundingClientRect();
			if (box.width === 0 || box.height === 0 || box.right <= width + 1) continue;
			if (getComputedStyle(element).position === "fixed" || clipped(element)) continue;
			offenders.push(
				`${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)} → ${Math.round(box.right)}`,
			);
		}
		const doc = document.documentElement;
		return { document: doc.scrollWidth - doc.clientWidth, offenders: offenders.slice(0, 6) };
	}, root);
}

/** Controls inside `root` that are on screen yet smaller than a finger (44 px each way). */
async function smallTargets(page: Page, root: string): Promise<string[]> {
	return page.evaluate(selector => {
		const small: string[] = [];
		const controls = document
			.querySelector(selector)
			?.querySelectorAll(
				'button, [role="button"], [role="switch"], [role="tab"], [role="option"], select, input:not([type="hidden"], [type="checkbox"], [type="radio"]), summary',
			);
		for (const element of controls ?? []) {
			// A list row's button spreads over the whole row (an ::after), so the row is the target.
			const box = (element.closest(".omp-list-row") ?? element).getBoundingClientRect();
			if (box.width === 0 || box.height === 0 || element.closest("[inert], [aria-hidden='true']")) continue;
			if (box.bottom < 0 || box.top > window.innerHeight) continue;
			if (Math.min(box.width, box.height) < 43.5) {
				const label = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 30) ?? "";
				small.push(
					`${element.tagName.toLowerCase()} "${label}" ${Math.round(box.width)}×${Math.round(box.height)}`,
				);
			}
		}
		return small;
	}, root);
}

// The default run keeps Chromium on the phone and on the tablet (one per layout); the small phone and WebKit
// repeat a layout and run with OMP_GUI_VARIANTS=1.
for (const { engine, device } of variants(
	ENGINES.flatMap(engine => DEVICES.map(device => ({ engine, device }))),
	({ engine, device }) => engine.name === "chromium" && device.name !== "small phone",
)) {
	test.describe(`${engine.name} · ${device.name}`, () => {
		let browser: Browser;

		test.beforeAll(async () => {
			browser = await engine.type.launch();
		});
		test.afterAll(async () => {
			await browser.close();
		});

		test("settings: a pushed page per section on a phone, two columns on a tablet", async () => {
			const page = await openHarness(browser, device, LIGHT_EN);
			await openDestination(page, "settings");
			const settings = page.locator("[data-settings-page]");
			await expect(settings).toBeVisible();
			const nav = page.locator(".settings-nav");
			const content = page.locator(".settings-content");
			if (device.phone) {
				await expect(settings).toHaveAttribute("data-stacked", "");
				// The list is the page: full-width rows, no section behind it.
				await expect(nav).toBeVisible();
				await expect(content).toHaveCount(0);
				const row = await page.locator('[data-settings-nav="appearance"]').boundingBox();
				expect(row?.width ?? 0).toBeGreaterThan((device.options?.viewport?.width ?? 0) - 32);
				expect(await overflow(page, "[data-settings-page]")).toEqual({ document: 0, offenders: [] });
				expect(await smallTargets(page, "[data-settings-page]")).toEqual([]);
				await capture(page, "settings-list", tagOf(engine.name, device, LIGHT_EN));

				await page.locator('[data-settings-section="appearance"]').click();
				await expect(page.locator("#settings-section-title")).toHaveText("Appearance & input");
				await expect(nav).toHaveCount(0);
				await expect(page.locator("[data-master-detail-back]")).toBeVisible();
				expect(await overflow(page, "[data-settings-page]")).toEqual({ document: 0, offenders: [] });
				await capture(page, "settings-detail", tagOf(engine.name, device, LIGHT_EN));

				// The system back gesture closes the section, the back button does too.
				const url = page.url();
				await page.goBack();
				await expect(nav).toBeVisible();
				await expect(content).toHaveCount(0);
				expect(page.url()).toBe(url);
				await page.locator('[data-settings-section="general"]').click();
				await expect(page.locator("#settings-section-title")).toHaveText("General");
				await page.locator("[data-master-detail-back]").click();
				await expect(nav).toBeVisible();

				// A search on the list page lists its results in place of the sections.
				await page.getByRole("searchbox").first().fill("theme");
				await expect(page.locator("[data-settings-nav-results]")).toBeVisible();
				await expect(page.locator("[data-settings-nav-results] [data-search-key]").first()).toBeVisible();
			} else {
				await expect(settings).not.toHaveAttribute("data-stacked", "");
				await expect(nav).toBeVisible();
				await expect(content).toBeVisible();
				await expect(page.locator("[data-master-detail-back]")).toHaveCount(0);
				const navBox = await nav.boundingBox();
				const contentBox = await content.boundingBox();
				expect(navBox?.width ?? 0).toBeLessThan(260);
				expect(contentBox?.x ?? 0).toBeGreaterThanOrEqual((navBox?.x ?? 0) + (navBox?.width ?? 0) - 1);
				await page.locator('[data-settings-section="appearance"]').click();
				await expect(page.locator("#settings-section-title")).toHaveText("Appearance & input");
				await expect(nav).toBeVisible();
				expect(await overflow(page, "[data-settings-page]")).toEqual({ document: 0, offenders: [] });
				expect(await smallTargets(page, "[data-settings-page]")).toEqual([]);
				await capture(page, "settings", tagOf(engine.name, device, LIGHT_EN));
			}
			await page.context().close();
		});

		test("settings rows: label above a full-width control, switches and info glyphs a finger wide", async () => {
			const page = await openHarness(browser, device, LIGHT_EN);
			await openDestination(page, "settings");
			await page.locator('[data-settings-section="agent"]').click();
			await expect(page.locator("#settings-section-title")).toHaveText("Agent behavior");
			const switches = page.locator(".settings-content [role='switch']");
			await expect(switches.first()).toBeVisible({ timeout: 15_000 });
			for (const box of await switches.evaluateAll(nodes =>
				nodes
					.map(node => node.getBoundingClientRect())
					.filter(rect => rect.width > 0)
					.map(rect => ({ width: rect.width, height: rect.height })),
			)) {
				expect(box.width).toBeGreaterThanOrEqual(43.5);
				expect(box.height).toBeGreaterThanOrEqual(43.5);
			}
			// "Advanced" stays folded until it is opened.
			const advanced = page.locator("[data-settings-advanced]").first();
			if ((await advanced.count()) > 0) await expect(advanced).not.toHaveAttribute("open", "");
			// A long description sits behind an info glyph that opens on a tap.
			const info = page.locator(".settings-content [data-setting-info]").first();
			if ((await info.count()) > 0) {
				const box = await info.boundingBox();
				expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(43.5);
				await info.tap();
				await expect(page.getByRole("tooltip")).toBeVisible();
			}
			expect(await overflow(page, "[data-settings-page]")).toEqual({ document: 0, offenders: [] });
			expect(await smallTargets(page, ".settings-content")).toEqual([]);
			await capture(page, "settings-rows", tagOf(engine.name, device, LIGHT_EN));

			if (device.phone) {
				// A row with a field stacks it under its label, full width.
				await page.locator("[data-master-detail-back]").click();
				await page.locator('[data-settings-section="general"]').click();
				await expect(page.locator("#settings-section-title")).toHaveText("General");
				const stacked = await page.evaluate(() => {
					const rows = [...document.querySelectorAll(".settings-field-row:not(.settings-field-row-compact)")];
					return rows
						.map(row => {
							const [label, control] = [...row.children].map(child => child.getBoundingClientRect());
							return label && control && control.width > 0
								? {
										below: control.top >= label.bottom - 1,
										width: control.width,
										row: row.getBoundingClientRect().width,
									}
								: null;
						})
						.filter(item => item !== null);
				});
				expect(stacked.length).toBeGreaterThan(0);
				for (const item of stacked) {
					expect(item.below).toBe(true);
					expect(item.width).toBeGreaterThan(item.row - 2);
				}
			}
			await page.context().close();
		});

		test("the device's push opt-in keeps its Turn on button at the right of its row", async () => {
			const page = await openHarness(browser, device, LIGHT_EN, "&pwa=push");
			await openDestination(page, "settings");
			await page.locator('[data-settings-section="connections"]').click();
			const row = page.locator("#settings-web-push");
			const button = row.locator("[data-web-push-enable]");
			await button.scrollIntoViewIfNeeded();
			await expect(button).toBeVisible();
			const label = await settled(row.getByText("Notifications are off", { exact: true }));
			const box = await button.boundingBox();
			const rowBox = await row.boundingBox();
			// One line: the button sits beside its label, at the right edge, sized to its text.
			expect((box?.y ?? 0) + (box?.height ?? 0)).toBeGreaterThan(label?.y ?? 0);
			expect(box?.y ?? 0).toBeLessThan((label?.y ?? 0) + (label?.height ?? 0));
			expect(box?.x ?? 0).toBeGreaterThan((label?.x ?? 0) + (label?.width ?? 0));
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeGreaterThan((rowBox?.x ?? 0) + (rowBox?.width ?? 0) - 1);
			expect(box?.width ?? 0).toBeLessThan((rowBox?.width ?? 0) / 3);
			expect(await smallTargets(page, "#settings-web-push")).toEqual([]);
			await page.context().close();
		});

		test("pull requests: list, then one pull request under a back button on a phone; both side by side on a tablet", async () => {
			const page = await openHarness(browser, device, LIGHT_EN);
			await openDestination(page, "agents");
			await page.getByRole("tab", { name: "Pull requests" }).click();
			const list = page.getByRole("navigation", { name: /pull requests/i });
			const first = list.getByRole("button", { name: /Stack settings rows/ });
			await expect(first).toBeVisible({ timeout: 15_000 });
			expect((await overflow(page, "body")).document).toBe(0);
			if (device.phone) {
				await expect(page.locator('[data-master-detail="stacked"][data-pane="list"]')).toBeVisible();
				await expect(page.getByRole("heading", { name: /Stack settings rows/ })).toHaveCount(0);
				await capture(page, "prs-list", tagOf(engine.name, device, LIGHT_EN));
				await first.click();
				await expect(page.locator('[data-master-detail="stacked"][data-pane="detail"]')).toBeVisible();
				await expect(page.getByRole("heading", { name: /Stack settings rows/ })).toBeVisible();
				await expect(first).toHaveCount(0);
				expect((await overflow(page, '[data-master-detail="stacked"]')).offenders).toEqual([]);
				expect(await smallTargets(page, '[data-master-detail="stacked"]')).toEqual([]);
				await capture(page, "prs-detail", tagOf(engine.name, device, LIGHT_EN));
				const url = page.url();
				await page.goBack();
				await expect(first).toBeVisible();
				expect(page.url()).toBe(url);
				await first.click();
				await page.locator("[data-master-detail-back]").click();
				await expect(first).toBeVisible();
			} else {
				await expect(page.locator('[data-master-detail="split"]')).toBeVisible();
				await first.click();
				await expect(page.getByRole("heading", { name: /Stack settings rows/ })).toBeVisible();
				await expect(first).toBeVisible();
				await expect(page.locator("[data-master-detail-back]")).toHaveCount(0);
				await capture(page, "prs", tagOf(engine.name, device, LIGHT_EN));
			}
			await page.context().close();
		});

		test("agents and insights: tabs stay on the screen and nothing runs wide", async () => {
			const page = await openHarness(browser, device, LIGHT_EN);
			await openDestination(page, "agents");
			for (const tab of ["Live", "Definitions", "Pull requests", "GitHub"]) {
				await page.getByRole("tab", { name: tab }).click();
				expect((await overflow(page, "body")).document).toBe(0);
			}
			await capture(page, "agents", tagOf(engine.name, device, LIGHT_EN));
			await menuButton(page).click();
			await drawer(page).locator('[data-destination="insights"]').click();
			await expect(page.getByRole("heading", { name: "Stats" }).first()).toBeVisible();
			expect((await overflow(page, "body")).document).toBe(0);
			await capture(page, "insights", tagOf(engine.name, device, LIGHT_EN));
			await page.context().close();
		});

		test("the model picker is a full-height sheet with its search pinned on a phone", async () => {
			const page = await openHarness(browser, device, LIGHT_EN);
			await page.locator("[data-model-chip]").click();
			const dialog = page.getByRole("dialog");
			const search = dialog.getByRole("searchbox", { name: "Search models" });
			await expect(search).toBeVisible();
			const options = dialog.locator("[data-model-option]");
			await expect(options.first()).toBeVisible({ timeout: 15_000 });
			const viewport = page.viewportSize() ?? { width: 0, height: 0 };
			const panel = await settled(dialog);
			expect((panel?.x ?? -1) + (panel?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 0.5);
			if (device.phone) {
				await expect(page.locator('[data-presentation="sheet"]')).toBeVisible();
				// Full height: the sheet runs from just under the status bar to the bottom edge.
				expect(panel?.height ?? 0).toBeGreaterThan(viewport.height * 0.85);
				expect((panel?.y ?? 0) + (panel?.height ?? 0)).toBeGreaterThanOrEqual(viewport.height - 1);
				// Rows are 56 px.
				for (const box of await options.evaluateAll(nodes =>
					nodes.map(node => node.getBoundingClientRect().height).filter(height => height > 0),
				))
					expect(box).toBeGreaterThanOrEqual(55.5);
				// The search stays where it is while the list scrolls.
				const before = await settled(search);
				await dialog.getByRole("listbox").evaluate(list => {
					list.scrollTop = list.scrollHeight;
				});
				const after = await search.boundingBox();
				expect(after?.y).toBe(before?.y);
			} else {
				for (const box of await options.evaluateAll(nodes =>
					nodes.map(node => node.getBoundingClientRect().height).filter(height => height > 0),
				))
					expect(box).toBeGreaterThanOrEqual(43.5);
			}
			expect(await smallTargets(page, '[role="dialog"]')).toEqual([]);
			await capture(page, "model-picker", tagOf(engine.name, device, LIGHT_EN));
			// Back closes the sheet on a phone (the layer it took).
			if (device.phone) {
				await page.goBack();
				await expect(dialog).toHaveCount(0);
			}
			await page.context().close();
		});

		for (const theme of ["light", "dark"] as const) {
			for (const lang of ["en", "ko"] as const) {
				test(`captures: ${theme} ${lang}`, async () => {
					test.skip(!captures, "OMP_GUI_MOBILE_PAGES=<dir> writes the captures");
					const look: Look = { theme, lang };
					const tag = tagOf(engine.name, device, look);
					// A pushed settings page replaces the menu button with a back button, so each page starts fresh.
					const fresh = async (extra = "") => openHarness(browser, device, look, extra);
					const settings = await fresh();
					await openDestination(settings, "settings");
					await capture(settings, "settings", tag);
					await settings.locator('[data-settings-section="agent"]').click();
					await capture(settings, "settings-section", tag);
					await settings.context().close();
					const agents = await fresh();
					await openDestination(agents, "agents");
					await capture(agents, "agents", tag);
					await agents.getByRole("tab").nth(2).click();
					await capture(agents, "pr-center", tag);
					await agents.context().close();
					// The device's own push opt-in and the iOS home-screen guide (Settings › Mobile web).
					for (const mode of ["push", "ios"] as const) {
						const web = await fresh(`&pwa=${mode}`);
						await openDestination(web, "settings");
						await web.locator('[data-settings-section="connections"]').click();
						await web.locator("[data-web-device-section]").scrollIntoViewIfNeeded();
						await expect(web.locator("[data-web-device-section]")).toBeVisible();
						await capture(web, `mobile-web-${mode}`, tag);
						await web.context().close();
					}
				});
			}
		}
	});
}
