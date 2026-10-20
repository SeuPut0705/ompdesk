import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { type Look, lookTag, measure, measureDensity, openLook, resetPage } from "./responsive-audit";
import { SURFACES } from "./responsive-surfaces";

// The default run's one responsive smoke: a phone (390) and a portrait tablet (834), en light, a handful of key
// surfaces (session, drawer, Mode popover, model picker, a side panel, Settings, Agents, a card, toasts). Nothing
// may scroll the page sideways, escape the viewport or open a popover off screen, and on the phone the idle
// session's app chrome (header + dock + composer, the hardware insets excluded) stays within 19.4 % of the screen.
// The full matrix (every surface × width × orientation × theme × language) is e2e/responsive-audit.e2e.ts, behind
// OMP_GUI_RESPONSIVE=<dir>.

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
 * sideways and nothing on it escapes the screen. The matrix covers the strip at every phone and tablet width.
 */
const BOARD_LOOKS: readonly Look[] = [
	{ width: 1600, height: 1000, dpr: 2, orientation: "landscape", theme: "light", lang: "ko" },
	{ width: 390, height: 844, dpr: 3, orientation: "portrait", theme: "light", lang: "ko" },
];

for (const look of BOARD_LOOKS) {
	test(`responsive smoke ${lookTag(look)}: the busy work board never scrolls sideways`, async () => {
		if (!browser) throw new Error("the browser is not up");
		const page = await openLook(browser, look, { origin, query: "&board=busy" });
		const strip = SURFACES.find(surface => surface.id === "board-strip");
		if (!strip) throw new Error("no board-strip surface");
		if (look.width < 1000) {
			await strip.open(page, look);
			if (strip.ready) await page.locator(strip.ready).waitFor({ state: "visible" });
		} else {
			await page.locator("[data-work-board-panel] [data-board-section='waiting']").waitFor({ timeout: 15_000 });
		}
		await page.waitForTimeout(600);
		const board = page.locator("[data-work-board-panel]").first();
		const widths = await board.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
		expect(widths.scroll, "the board's content width").toBeLessThanOrEqual(widths.client);
		const hard = (await measure(page, look)).filter(issue => HARD.has(issue.kind));
		expect(hard).toEqual([]);
		await page.context().close();
	});
}
