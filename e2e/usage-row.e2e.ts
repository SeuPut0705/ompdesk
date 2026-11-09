/**
 * The usage row under a reply (`components/chat/UsageRow.tsx`) stays one line at every width: a narrow row drops its
 * least useful segments first and shortens the model's name, it never wraps and never scrolls sideways; a wide row
 * shows every segment. Runs on the dev harness (the renderer in a browser over a fixture transport,
 * `vite.harness.config.ts`), whose last reply carries every segment (`src/renderer/dev-harness/fixture.ts`).
 */
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser | undefined;

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
	await server?.close();
});

const SEGMENTS = ["model", "input", "output", "cache", "cost", "duration", "ttft", "rate"];

/** The harness at `width`, its usage rows on, scrolled to the reply that carries every segment. */
async function openRow(page: Page, lang: "en" | "ko"): Promise<void> {
	await page.goto(`${origin}/harness.html?theme=light&lang=${lang}`);
	await page.waitForFunction(() => window.__stores?.ui !== undefined, undefined, { timeout: 45_000 });
	await page.evaluate(() => {
		const ui = window.__stores?.ui as unknown as {
			setState: (update: (state: { displayPreferences: Record<string, unknown> }) => object) => void;
		};
		ui.setState(state => ({ displayPreferences: { ...state.displayPreferences, showTokenUsage: true } }));
	});
	const row = page.locator(".omp-usage-row").last();
	await expect(row).toBeVisible({ timeout: 30_000 });
	await row.scrollIntoViewIfNeeded();
}

/** The row's height in lines of its own text, how far its content runs past its box, and its shown segments. */
function measure(page: Page) {
	return page
		.locator(".omp-usage-row")
		.last()
		.evaluate(row => {
			const box = row.getBoundingClientRect();
			const lineHeight = Number.parseFloat(getComputedStyle(row).lineHeight);
			const segments = [...row.querySelectorAll<HTMLElement>("[data-usage-segment]")];
			// Past the row's right edge: a segment cut off or pushed out (a model name's own ellipsis is inside it).
			const overflow = Math.max(
				0,
				row.scrollWidth - row.clientWidth,
				...segments.map(segment => segment.getBoundingClientRect().right - box.right),
			);
			const shown = segments
				.filter(segment => segment.getBoundingClientRect().width > 0)
				.map(segment => segment.dataset.usageSegment ?? "");
			return {
				lines: box.height / lineHeight,
				overflow,
				shown,
				text: (row as HTMLElement).innerText,
			};
		});
}

for (const lang of ["en", "ko"] as const) {
	test(`the usage row is one line on a phone, every segment on a wide window (${lang})`, async () => {
		if (!browser) throw new Error("no browser");
		const phone = await browser.newContext({
			viewport: { width: 390, height: 844 },
			deviceScaleFactor: 3,
			isMobile: true,
			hasTouch: true,
		});
		try {
			const page = await phone.newPage();
			await openRow(page, lang);
			for (const width of [390, 320, 360, 412, 600, 768]) {
				await page.setViewportSize({ width, height: 844 });
				const row = await measure(page);
				expect(row.lines, `${width} px: ${row.text}`).toBeLessThan(1.5);
				expect(row.overflow, `${width} px scrolls sideways`).toBeLessThanOrEqual(1);
				// The model, the output and the cost stay at every phone width.
				expect(row.shown, `${width} px`).toEqual(expect.arrayContaining(["model", "output", "cost"]));
			}
		} finally {
			await phone.close();
		}
		const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
		try {
			const page = await desktop.newPage();
			await openRow(page, lang);
			const row = await measure(page);
			expect(row.lines, row.text).toBeLessThan(1.5);
			expect(row.shown).toEqual(SEGMENTS);
		} finally {
			await desktop.close();
		}
	});
}
