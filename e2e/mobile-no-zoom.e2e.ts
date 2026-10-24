/**
 * A phone's page is an app, not a document: a pinch or a double tap never zooms it (the user's report, 23 Oct 2026:
 * a pinch on the page zoomed the whole app, and the composer and the bars went off screen). Runs on the dev harness
 * (`vite.harness.config.ts`, the same viewport meta as `web.html`) as an iPhone in Chromium, whose pinch goes through
 * the page's viewport meta and `touch-action` as a real phone's does. iOS Safari ignores both for a pinch, so its
 * WebKit gesture events are refused (`lib/no-page-zoom.ts`), pinned by `no-page-zoom.test.ts`.
 */
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, test } from "@playwright/test";
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

test("a pinch and a double tap on a phone's page leave it unzoomed", async () => {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 390, height: 844 } });
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?lang=en`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await expect(page.locator("html[data-shell='phone']")).toHaveCount(1);
	const scale = () => page.evaluate(() => window.visualViewport?.scale ?? 1);
	expect(await scale()).toBe(1);

	const cdp = await context.newCDPSession(page);
	// Over the transcript, then over the composer: both spread apart to three times the size.
	for (const target of ["[data-transcript-kind]", ".omp-composer-box"]) {
		const box = await page.locator(target).first().boundingBox();
		if (!box) throw new Error(`no ${target}`);
		await cdp.send("Input.synthesizePinchGesture", {
			x: Math.round(box.x + box.width / 2),
			y: Math.round(box.y + Math.min(box.height / 2, 120)),
			scaleFactor: 3,
			gestureSourceType: "touch",
		});
		await page.waitForTimeout(300);
		expect(await scale(), `pinch over ${target}`).toBe(1);
	}

	const header = await page.locator("[data-titlebar-session-name]").boundingBox();
	if (!header) throw new Error("no header");
	await cdp.send("Input.synthesizeTapGesture", {
		x: Math.round(header.x + 4),
		y: Math.round(header.y + header.height + 200),
		tapCount: 2,
		gestureSourceType: "touch",
	});
	await page.waitForTimeout(300);
	expect(await scale(), "double tap").toBe(1);
	await context.close();
});
