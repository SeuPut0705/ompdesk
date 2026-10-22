import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { type Look, lookTag, measure, measureDensity, openLook, resetPage } from "./responsive-audit";
import { SURFACES } from "./responsive-surfaces";

// The default run's responsive smoke: a phone (390) and a portrait tablet (834), en light, a handful of key surfaces
// (session, drawer, Mode popover, model picker, a side panel, Settings, Agents, a card, toasts). Nothing may scroll
// the page sideways, escape the viewport or open a popover off screen, and on the phone the idle session's app chrome
// (header + dock + composer, the hardware insets excluded) stays within 19.4 % of the screen. Then the classes the
// responsive pass of 20 Oct 2026 fixed, so they cannot come back: every tap reaches its own control (no stolen taps,
// nothing under the home indicator, 36 px targets in a docked tablet sidebar, whole summary figures on a work card),
// a tap on the drawer's edge strip reaches the control under it, and a 1100 px desktop window keeps Memory's tabs clear
// of its project picker and cuts no Run popover choice. An Autopilot run's board (an iPad mini sideways, docked; a
// phone's strip) never scrolls sideways, its controls are 36 px targets, and the goal bar's buttons keep their taps. The full matrix (every surface × width × orientation × theme ×
// language × touch, web and Electron desktop) is e2e/responsive-audit.e2e.ts, behind OMP_GUI_RESPONSIVE=<dir>.

const LOOKS: readonly Look[] = [
	{ width: 390, height: 844, dpr: 3, orientation: "portrait", theme: "light", lang: "en" },
	{ width: 834, height: 1194, dpr: 2, orientation: "portrait", theme: "light", lang: "en" },
];

const KEY_SURFACES = [
	"session-idle",
	"sidebar",
	"transcript-stress",
	"composer-mode-plan",
	"model-picker",
	"panel-files",
	"settings-general",
	"agents-live",
	"card-approval",
	"toasts",
];

/** What the smoke refuses; the matrix also counts the softer kinds (targets, text size, truncation). */
const HARD = new Set(["overflow-page", "overflow-el", "overflow-sideways", "offscreen-popover"]);

/**
 * The phone's app chrome budget at rest, percent of the screen height (header + work chip + dock + composer): the
 * always-open composer (a full-width field row over one row of every control, all inside the box) measured 18.4 % at
 * 390x844, plus one point. The user chose the open composer over a lower share.
 */
const CHROME_SHARE_MAX = 19.4;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser | undefined;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
	});
	return promise;
}

// A cold Vite dev server can reload once while it optimizes dependencies; a second try is that, not a flake.
test.describe.configure({ retries: 1 });

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
	await server?.close();
});

for (const look of LOOKS) {
	test(`responsive smoke ${lookTag(look)}: nothing overflows, no popover leaves the screen`, async () => {
		if (!browser) throw new Error("the browser is not up");
		const page = await openLook(browser, look, { origin });
		const surfaces = KEY_SURFACES.map(id => SURFACES.find(surface => surface.id === id)).filter(
			(surface): surface is (typeof SURFACES)[number] => surface !== undefined,
		);
		expect(surfaces.map(surface => surface.id)).toEqual(KEY_SURFACES);
		for (const surface of surfaces) {
			if (!(await resetPage(page))) {
				await page.reload();
				await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
			}
			await surface.open(page, look);
			if (surface.ready) await page.locator(surface.ready).first().waitFor({ state: "visible", timeout: 8_000 });
			await page.waitForTimeout(surface.settle ?? 450);
			const hard = (await measure(page, look)).filter(issue => HARD.has(issue.kind));
			expect(hard, `${surface.id} at ${look.width}`).toEqual([]);
			if (surface.id === "session-idle" && look.width < 600) {
				const density = await measureDensity(page, look);
				expect(density, "the idle session has a transcript to measure").toBeDefined();
				expect(density?.chromeShare ?? 100).toBeLessThanOrEqual(CHROME_SHARE_MAX);
			}
		}
		await page.context().close();
	});
}

/**
 * A phone turned sideways (iPhone 14/15 at 844×390): the session surfaces carry none of the softer findings either
 * (hit areas, stolen taps, truncated controls, text under 11.5 px). The landscape rules are mobile.css's
 * `html[data-shell="phone"]` block under `(orientation: landscape)`; portrait phones and tablets keep their own.
 */
const PHONE_LANDSCAPE: Look = { width: 844, height: 390, dpr: 3, orientation: "landscape", theme: "light", lang: "en" };
const LANDSCAPE_SURFACES = ["session-idle", "transcript-stress"];

test("responsive smoke phone landscape: the session's controls keep their taps and text", async () => {
	if (!browser) throw new Error("the browser is not up");
	const page = await openLook(browser, PHONE_LANDSCAPE, { origin });
	expect(await page.evaluate(() => document.documentElement.dataset.shell)).toBe("phone");
	const found: string[] = [];
	for (const id of LANDSCAPE_SURFACES) {
		const surface = SURFACES.find(entry => entry.id === id);
		if (!surface) throw new Error(`no surface ${id}`);
		if (!(await resetPage(page))) {
			await page.reload();
			await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
		}
		await surface.open(page, PHONE_LANDSCAPE);
		if (surface.ready) await page.locator(surface.ready).first().waitFor({ state: "visible", timeout: 8_000 });
		await page.waitForTimeout(surface.settle ?? 450);
		for (const issue of await measure(page, PHONE_LANDSCAPE))
			if (issue.kind !== "safe-area") found.push(`${id}: ${issue.kind} ${issue.at} ${issue.detail}`);
	}
	expect(found).toEqual([]);
	await page.context().close();
});

/**
 * The work board with everything at once and long Korean content (?board=busy: long titles, an `omp/agent/…`
 * branch, an OpenRouter charge): docked beside a wide pane and inside the phone's expanded strip, it never scrolls
 * sideways and nothing on it escapes the screen. A tablet held sideways docks it beside a narrowed transcript
 * (`workBoardDocks`): an iPad Pro 12.9" and an iPad mini with their sidebars open; a 1024 px tablet with its sidebar
 * open keeps the strip. The matrix covers the strip at every phone and tablet width.
 */
const BOARD_LOOKS: readonly (Look & { form: "docked" | "strip" })[] = [
	{ width: 1600, height: 1000, dpr: 2, orientation: "landscape", theme: "light", lang: "ko", form: "docked" },
	{ width: 1366, height: 1024, dpr: 2, orientation: "landscape", theme: "light", lang: "ko", form: "docked" },
	{ width: 1133, height: 744, dpr: 2, orientation: "landscape", theme: "light", lang: "ko", form: "docked" },
	{ width: 1024, height: 768, dpr: 2, orientation: "landscape", theme: "light", lang: "ko", form: "strip" },
	{ width: 390, height: 844, dpr: 3, orientation: "portrait", theme: "light", lang: "ko", form: "strip" },
];

for (const look of BOARD_LOOKS) {
	test(`responsive smoke ${lookTag(look)}: the busy work board never scrolls sideways`, async () => {
		if (!browser) throw new Error("the browser is not up");
		const page = await openLook(browser, look, { origin, query: "&board=busy" });
		const strip = SURFACES.find(surface => surface.id === "board-strip");
		if (!strip) throw new Error("no board-strip surface");
		await strip.open(page, look);
		if (strip.ready) await page.locator(strip.ready).first().waitFor({ state: "visible" });
		await page.waitForTimeout(600);
		expect(await page.locator(".omp-work-board-slot [data-work-board-panel]").count(), "docked").toBe(
			look.form === "docked" ? 1 : 0,
		);
		expect(await page.locator("[data-work-strip-panel]").count(), "strip expanded").toBe(
			look.form === "strip" ? 1 : 0,
		);
		const board = page.locator("[data-work-board-panel]").first();
		const widths = await board.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
		expect(widths.scroll, "the board's content width").toBeLessThanOrEqual(widths.client);
		const hard = (await measure(page, look)).filter(issue => HARD.has(issue.kind));
		expect(hard).toEqual([]);
		await page.context().close();
	});
}

/**
 * An Autopilot run's board (its controls, the log's copy, follow-ups with their pins, the backlog's ✕) docked beside
 * an iPad mini held sideways and in the phone's expanded strip: it never scrolls sideways (a row button's reach once
 * did, by 2 px) and each of its controls is a 36 px target that takes only its own taps (24 to 28 px before 22 Oct
 * 2026). Beside it the goal dock bar, whose Pause handed its right edge's taps to Edit on that iPad.
 */
const AUTOPILOT_LOOKS: readonly (Look & { form: "docked" | "strip" })[] = [
	{ width: 1133, height: 744, dpr: 2, orientation: "landscape", theme: "light", lang: "en", form: "docked" },
	{ width: 390, height: 844, dpr: 3, orientation: "portrait", theme: "light", lang: "ko", form: "strip" },
];
const AUTOPILOT_PARTS = ["omp-work-board", "data-autopilot", "data-goal-dock"];

for (const look of AUTOPILOT_LOOKS) {
	test(`responsive smoke ${lookTag(look)}: the Autopilot board and the goal bar keep their taps`, async () => {
		if (!browser) throw new Error("the browser is not up");
		const found: string[] = [];
		// One page each: once the Autopilot board shows, the tab is a run's and its board has no waiting section.
		for (const id of ["board-strip", "autopilot-board"]) {
			const query = SURFACES.find(surface => surface.id === id)?.query ?? "";
			const page = await openLook(browser, look, { origin, query });
			await show(page, look, id);
			if (id === "autopilot-board") {
				const board = page.locator("[data-work-board-panel]").first();
				expect(await board.locator("[data-autopilot-followup-pin]").count(), "a follow-up's pin").toBeGreaterThan(
					0,
				);
				expect(await page.locator(".omp-work-board-slot [data-work-board-panel]").count(), "docked").toBe(
					look.form === "docked" ? 1 : 0,
				);
				const widths = await board.evaluate(element => ({
					scroll: element.scrollWidth,
					client: element.clientWidth,
				}));
				expect(widths.scroll, "the board's content width").toBeLessThanOrEqual(widths.client);
			}
			for (const issue of await measure(page, look)) {
				// The composer's own chips (the run's chip among them) are the composer's rules, not the board's.
				const ours =
					AUTOPILOT_PARTS.some(part => issue.at.includes(part)) && !issue.at.includes("omp-composer-toolbar");
				if (ours && ["stolen-tap", "small-target", "overflow-sideways", "overlap"].includes(issue.kind))
					found.push(`${id}: ${issue.kind} ${issue.at} ${issue.detail}`);
			}
			await page.context().close();
		}
		expect(found).toEqual([]);
	});
}

/** Open one named surface on a page that already shows the harness (reloading when something modal stayed up). */
async function show(page: Page, look: Look, id: string): Promise<void> {
	const surface = SURFACES.find(entry => entry.id === id);
	if (!surface) throw new Error(`no surface ${id}`);
	if (!(await resetPage(page))) {
		await page.reload();
		await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	}
	await surface.open(page, look);
	if (surface.ready) await page.locator(surface.ready).first().waitFor({ state: "visible", timeout: 8_000 });
	await page.waitForTimeout(surface.settle ?? 450);
}

/**
 * What a finger aims at, it gets: on a phone and a portrait tablet no control loses part of its hit area to a
 * neighbour, an edge strip or a layer (tabs over the content below, sheet items over the next item, the sidebar's
 * project ⋯ over the title, the composer's last chip under Send, a notice's buttons over the work strip, wrapped
 * section pills, a Settings info glyph over the glyph or button on the next line), nothing sits under the home
 * indicator (a full-screen sheet's footer), a work card's summary never cuts a figure, a docked tablet sidebar's
 * controls are 36 px targets, the feedback and worktree dialogs' checkbox and radio rows keep their own taps, and a
 * question card's step tabs and a figure header's buttons are 36 px targets. The matrix measures every surface.
 */
const TOUCH_LOOKS: readonly Look[] = [
	{ width: 390, height: 844, dpr: 3, orientation: "portrait", theme: "light", lang: "en" },
	{ width: 834, height: 1194, dpr: 2, orientation: "portrait", theme: "light", lang: "en" },
];
const TAP_SURFACES = [
	"session-idle",
	"sidebar",
	"banner-update-error",
	"composer-attach-menu",
	"composer-run-settings",
	"stats-all",
	"agents-prs",
	"settings-general",
	"settings-memory-search",
	"settings-models",
	"settings-keyboard",
	"panel-files",
	"dialog-feedback",
	"dialog-worktree",
	"card-ask",
	"dialog-plan-approval",
];
const HOST_SURFACES = ["host-path-actions", "host-browser-folder"];

for (const look of TOUCH_LOOKS) {
	test(`responsive smoke ${lookTag(look)}: every tap reaches the control it aims at`, async () => {
		if (!browser) throw new Error("the browser is not up");
		const found: string[] = [];
		const check = async (page: Page, id: string) => {
			await show(page, look, id);
			for (const issue of await measure(page, look)) {
				const summaryCut = issue.kind === "truncated" && issue.at.includes("omp-summary-part");
				const sidebarTarget = issue.kind === "small-target" && issue.at.includes("[data-sidebar-");
				// A question card's step tabs and a figure header's buttons reach 36 through their spacing (mobile.css).
				const spacedTarget =
					issue.kind === "small-target" && /\[data-ask-step\]|\[data-figure-header\]/.test(issue.at);
				// The work strip under the header is 28 px drawn and reaches 36 down over the transcript's top.
				const workStrip = issue.kind === "small-target" && issue.at.includes("[data-work-chip]");
				if (
					["stolen-tap", "safe-area", "overlap"].includes(issue.kind) ||
					summaryCut ||
					sidebarTarget ||
					spacedTarget ||
					workStrip
				)
					found.push(`${id}: ${issue.kind} ${issue.at} ${issue.detail}`);
			}
		};
		const page = await openLook(browser, look, { origin });
		for (const id of TAP_SURFACES) await check(page, id);
		await page.context().close();
		const hosted = await openLook(browser, look, { origin, query: "&host=1" });
		for (const id of HOST_SURFACES) await check(hosted, id);
		await hosted.context().close();
		// The busy work strip's finished card: its Steps toggle over its findings row (a tablet's toggle once lost its
		// bottom edge to the failing step's cause).
		const busy = await openLook(browser, look, { origin, query: "&board=busy" });
		await check(busy, "board-strip");
		await busy.context().close();
		expect(found).toEqual([]);
	});
}

test("responsive smoke 390: a tap on the drawer's edge strip reaches the control under it", async () => {
	if (!browser) throw new Error("the browser is not up");
	const look = TOUCH_LOOKS[0] as Look;
	const page = await openLook(browser, look, { origin });
	await show(page, look, "agents-prs");
	const strip = await page.locator("[data-edge-zone]").boundingBox();
	if (!strip) throw new Error("no edge strip");
	// The PR list's rows start 8 px from the screen's edge, so the strip lies over their first 2 px.
	const row = page.locator("nav > ul > li > button").first();
	const box = await row.boundingBox();
	if (!box) throw new Error("no PR row");
	expect(box.x).toBeLessThan(strip.x + strip.width);
	await page.touchscreen.tap(strip.x + strip.width - 1, box.y + box.height / 2);
	await expect(page.locator("[data-master-detail-back]")).toBeVisible();
	await page.context().close();
});

/**
 * A desktop window (painted as the Electron window it is, `?platform=darwin`) at 1100 px: Settings › Memory's tabs and
 * project picker share the row without one covering the other, and the Run popover's segmented choices cut no label.
 */
test("responsive smoke 1100 desktop: Memory's tabs and the Run popover's choices fit", async () => {
	if (!browser) throw new Error("the browser is not up");
	const look: Look = {
		width: 1100,
		height: 800,
		dpr: 2,
		orientation: "landscape",
		theme: "light",
		lang: "en",
		device: "electron",
	};
	const page = await openLook(browser, look, { origin });
	const found: string[] = [];
	for (const id of ["settings-memory-maintenance", "composer-run-settings"]) {
		await show(page, look, id);
		for (const issue of await measure(page, look))
			if (issue.kind === "overlap" || (issue.kind === "truncated" && issue.at.includes("-option]")))
				found.push(`${id}: ${issue.kind} ${issue.at} ${issue.detail}`);
	}
	expect(found).toEqual([]);
	await page.context().close();
});

/**
 * With Reduce motion on (every look here emulates it), a diagram still lays out: the global rule once forced every
 * element's transitions to 0.01 ms, so a label mermaid styled and then measured read its pre-transition size and the
 * stress transcript's five-node flowchart came out 2107×2188 with its labels collapsed (22 Oct 2026).
 */
test("responsive smoke 1280 desktop: a mermaid diagram lays out under Reduce motion", async () => {
	if (!browser) throw new Error("the browser is not up");
	const look: Look = {
		width: 1280,
		height: 800,
		dpr: 1,
		orientation: "landscape",
		theme: "light",
		lang: "en",
		device: "electron",
	};
	const page = await openLook(browser, look, { origin });
	expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
	const diagram = page.locator('[data-figure="mermaid"] [data-zoomable-image] img').first();
	await diagram.scrollIntoViewIfNeeded({ timeout: 30_000 });
	await expect(diagram).toBeVisible();
	const size = await diagram.evaluate(img => ({
		width: (img as HTMLImageElement).naturalWidth,
		height: (img as HTMLImageElement).naturalHeight,
	}));
	// About 200×300 laid out; the broken layout was ten times that.
	expect(size.width).toBeGreaterThan(100);
	expect(size.width).toBeLessThan(600);
	expect(size.height).toBeLessThan(600);
	await page.context().close();
});

/**
 * A desktop window too narrow to dock the board (1280 wide beside the sidebar) keeps its work strip in the dock just
 * above the composer, where the phone's sits under the header. Its panel opened downward there, over the composer
 * and past the window's bottom edge, so the board's rows were cut off and the composer could not be clicked until
 * the strip was collapsed (22 Oct 2026). It opens upward now, clear of the composer, and no taller than the room its
 * pane has above the strip: a short window (or a pane of a split stacked in two) once cut its top off instead.
 */
const STRIP_ROOMS: readonly { height: number; draft?: number }[] = [
	{ height: 800 },
	{ height: 480 },
	// A pane as short as a split stacked in two: no room above the strip, the composer just under the dock.
	{ height: 360, draft: 1 },
];
for (const { height, draft } of STRIP_ROOMS) {
	const name = draft ? `1280×${height} desktop with a draft` : `1280×${height} desktop`;
	test(`responsive smoke ${name}: the expanded work strip stays in its pane, clear of the composer`, async () => {
		if (!browser) throw new Error("the browser is not up");
		const look: Look = {
			width: 1280,
			height,
			dpr: 1,
			orientation: "landscape",
			theme: "light",
			lang: "en",
			device: "electron",
		};
		const page = await openLook(browser, look, { origin, query: "&board=busy" });
		// Collapsed above room to open into, its chevron already points up (the panel's way).
		if (height === 800) await expect(page.locator("[data-work-chip]")).toHaveAttribute("data-opens", "up");
		await show(page, look, "board-strip");
		if (draft)
			await page
				.locator(".omp-composer-box textarea")
				.first()
				.fill(Array.from({ length: draft }, (_, line) => `line ${line + 1} of a long draft`).join("\n"));
		// The dock settles after the strip opens (the question card lands), and the panel follows it: read it settled.
		const fits = async () => {
			const panel = await page.locator("[data-work-strip-panel]").boundingBox();
			const pane = await page.locator(".omp-session-pane").first().boundingBox();
			const composer = await page.locator(".omp-composer-box").first().boundingBox();
			if (!panel || !pane || !composer) return "no strip panel, pane or composer";
			if (panel.y < pane.y) return `panel's top ${panel.y} above its pane's ${pane.y}`;
			if (panel.y + panel.height > composer.y)
				return `panel's bottom ${panel.y + panel.height} over the composer at ${composer.y}`;
			if (!draft && panel.height <= 80) return `panel only ${panel.height}px tall`;
			return "fits";
		};
		await expect.poll(fits, { timeout: 5_000 }).toBe("fits");
		await page.context().close();
	});
}

/**
 * More toasts than a short window holds (eight is the store's cap) once ran past its bottom edge, the newest and its
 * close button out of reach (22 Oct 2026, the audit at 834×600). The stack scrolls inside the window now, and a wheel
 * over a toast scrolls it although the stack itself takes no pointer events.
 */
test("responsive smoke 1280×480 desktop: a stack of toasts taller than the window scrolls to its newest", async () => {
	if (!browser) throw new Error("the browser is not up");
	const look: Look = {
		width: 1280,
		height: 480,
		dpr: 1,
		orientation: "landscape",
		theme: "light",
		lang: "en",
		device: "electron",
	};
	const page = await openLook(browser, look, { origin });
	await page.evaluate(() => {
		const toast = window.__stores?.toast?.getState() as { push(input: unknown): void } | undefined;
		for (let index = 0; index < 6; index++)
			toast?.push({
				variant: "info",
				title: `Toast ${index}`,
				message: "A message long enough to take a few lines in a 320 px toast, so six of them overflow.",
				durationMs: Number.POSITIVE_INFINITY,
			});
	});
	const scroller = page.locator("[data-toast-scroll]");
	await expect(page.getByText("Toast 5")).toBeAttached();
	const box = await scroller.evaluate(element => {
		const rect = element.getBoundingClientRect();
		return { bottom: rect.bottom, overflows: element.scrollHeight > element.clientHeight };
	});
	expect(box.overflows).toBe(true);
	expect(box.bottom).toBeLessThanOrEqual(480);
	const first = page.getByText("Toast 0");
	await first.hover();
	await page.mouse.wheel(0, 2000);
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
	const newest = await page
		.getByText("Toast 5")
		.locator("xpath=ancestor::*[@role='status'][1]")
		.evaluate(element => element.getBoundingClientRect().bottom);
	expect(newest).toBeLessThanOrEqual(480);
	await page.context().close();
});
