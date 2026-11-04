import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { type Look, openLook, resetPage } from "./responsive-audit";
import { SURFACES } from "./responsive-surfaces";

// Windows draws its caption buttons (minimize, maximize, close; 3 × 46 px over the 48 px top band) over the app's
// top-right corner, and they take every click there. The dev harness painted as a Windows window
// (`?platform=win32`, src/renderer/dev-harness/boot.ts) stands them in, so this measures what the app puts under
// them: on every surface below no control may lie in the band. Before 4 Nov 2026 a right sheet's close ✕, a tall
// dialog's header and the compact window's panel sheet sat there (the owner, on the Windows PC: "겹치는 UI가 많이
// 보임"). `OMP_GUI_CAPTION_CAPTURES=<dir>` also writes one PNG per surface.

const DESKTOP: Look = { width: 1280, height: 800, dpr: 1, orientation: "landscape", theme: "light", lang: "en" };
/** A window narrower than 1000 px: the side panel becomes a sheet (useCompactShell). */
const COMPACT: Look = { width: 900, height: 640, dpr: 1, orientation: "landscape", theme: "light", lang: "en" };
/** A short window: a tall dialog reaches the top edge. */
const SHORT: Look = { width: 1280, height: 560, dpr: 1, orientation: "landscape", theme: "light", lang: "en" };

const CAPTION_WIDTH = 138;
const CAPTION_HEIGHT = 48;

const SURFACE_LOOKS: ReadonlyArray<{ look: Look; surfaces: readonly string[] }> = [
	{
		look: DESKTOP,
		surfaces: ["session-idle", "sheet-jobs", "sheet-tree", "sheet-work", "panel-files", "settings-general", "toasts"],
	},
	{ look: COMPACT, surfaces: ["session-idle", "panel-files", "sheet-plan"] },
	{
		look: SHORT,
		surfaces: [
			"dialog-theme-picker",
			"dialog-model-setup",
			"dialog-debug",
			"dialog-command-palette",
			"dialog-rename",
			"dialog-benchmark",
		],
	},
];

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser | undefined;
const captures = process.env.OMP_GUI_CAPTION_CAPTURES;

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
	if (captures) await fs.mkdir(captures, { recursive: true });
});

test.afterAll(async () => {
	await browser?.close();
	await server?.close();
});

/** The controls whose on-screen box reaches into the caption band, as `tag#id.class "label" @x,y w×h`. */
async function controlsUnderCaption(page: Page): Promise<string[]> {
	return page.evaluate(
		({ width, height }) => {
			const band = { left: innerWidth - width, bottom: height };
			const found: string[] = [];
			const controls = document.querySelectorAll<HTMLElement>(
				'button, [role="button"], a[href], input, select, textarea, [role="tab"], [role="menuitem"], [role="option"], [contenteditable="true"]',
			);
			for (const control of controls) {
				if (control.closest("[data-caption-buttons]") || control.getAttribute("aria-hidden") === "true") continue;
				const box = control.getBoundingClientRect();
				if (box.width === 0 || box.height === 0) continue;
				if (box.right <= band.left || box.top >= band.bottom) continue;
				// The part inside the band must be what the person sees there: a control under a layer (a sheet's backdrop
				// over the title bar) is covered, not offered.
				const x = Math.min(box.right, innerWidth) - Math.min(8, box.width / 2);
				const y = Math.max(box.top, 0) + Math.min(8, box.height / 2);
				const top = document.elementFromPoint(x, y);
				if (!top || (top !== control && !control.contains(top))) continue;
				const label = (control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 40);
				const id = control.id ? `#${control.id}` : "";
				const cls =
					control.className && typeof control.className === "string"
						? `.${control.className.split(/\s+/)[0]}`
						: "";
				found.push(
					`${control.tagName.toLowerCase()}${id}${cls} "${label}" @${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}×${Math.round(box.height)}`,
				);
			}
			return found;
		},
		{ width: CAPTION_WIDTH, height: CAPTION_HEIGHT },
	);
}

for (const { look, surfaces } of SURFACE_LOOKS) {
	test(`a Windows window ${look.width}×${look.height} keeps every control out from under the caption buttons`, async () => {
		if (!browser) throw new Error("the browser is not up");
		const page = await openLook(browser, look, { origin, query: "&platform=win32" });
		expect(await page.locator("[data-caption-buttons]").count(), "the harness paints the caption buttons").toBe(1);
		const found = surfaces.map(id => SURFACES.find(surface => surface.id === id));
		expect(found.map(surface => surface?.id)).toEqual(surfaces);
		const failures: string[] = [];
		for (const surface of found) {
			if (!surface) continue;
			if (!(await resetPage(page))) {
				await page.reload();
				await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
			}
			await surface.open(page, look);
			if (surface.ready) await page.locator(surface.ready).first().waitFor({ state: "visible", timeout: 8_000 });
			await page.waitForTimeout(surface.settle ?? 450);
			if (captures) {
				await page.screenshot({ path: path.join(captures, `${look.width}x${look.height}-${surface.id}.png`) });
			}
			const under = await controlsUnderCaption(page);
			if (under.length > 0) failures.push(`${surface.id}: ${under.join("; ")}`);
		}
		expect(failures).toEqual([]);
		await page.context().close();
	});
}
