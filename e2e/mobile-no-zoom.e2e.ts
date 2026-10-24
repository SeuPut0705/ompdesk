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

test("two fingers zoom a picture in the viewer, never the page, and one finger then moves it", async () => {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 390, height: 844 } });
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?lang=en&stress=1`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.evaluate(() => {
		const row = document.querySelector("[data-transcript-kind]");
		let node = row?.parentElement ?? null;
		while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
		if (node) node.scrollTop = node.scrollHeight;
	});
	const picture = page.locator("[data-zoomable-image]").last();
	await picture.waitFor({ state: "visible", timeout: 15_000 });
	await picture.click();
	const viewer = page.locator("[data-image-viewer]");
	await expect(viewer).toBeVisible();
	const image = viewer.locator("img");
	const imageScale = () =>
		image.evaluate(node => {
			const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
			return { scale: matrix.a, x: matrix.e, y: matrix.f };
		});
	const box = await viewer.boundingBox();
	if (!box) throw new Error("no viewer");
	const center = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
	const cdp = await context.newCDPSession(page);
	await cdp.send("Input.synthesizePinchGesture", { ...center, scaleFactor: 2.5, gestureSourceType: "touch" });
	await page.waitForTimeout(300);
	expect(await page.evaluate(() => window.visualViewport?.scale ?? 1), "the page").toBe(1);
	const zoomed = await imageScale();
	expect(zoomed.scale).toBeGreaterThan(1.8);
	// A tap does not drop the zoom into actual size: the pinch's own lift is no click.
	await expect(viewer).toHaveAttribute("aria-pressed", "false");

	await cdp.send("Input.synthesizeScrollGesture", {
		...center,
		xDistance: 80,
		yDistance: 0,
		gestureSourceType: "touch",
		speed: 400,
	});
	await page.waitForTimeout(300);
	const moved = await imageScale();
	expect(moved.scale).toBeCloseTo(zoomed.scale, 2);
	expect(moved.x).toBeGreaterThan(zoomed.x + 40);
	expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

	// Closing and opening again starts from the fit.
	await page.keyboard.press("Escape");
	await picture.click();
	await expect(viewer).toBeVisible();
	expect((await imageScale()).scale).toBe(1);
	// A tap zooms in around the finger, the next one back to the fit; neither is actual size, which a mouse click keeps.
	await viewer.tap();
	await expect.poll(async () => (await imageScale()).scale).toBeCloseTo(2.5, 2);
	await viewer.tap();
	await expect.poll(async () => (await imageScale()).scale).toBe(1);
	await expect(viewer).toHaveAttribute("aria-pressed", "false");
	await context.close();
});

test("two fingers zoom an opened file, never the page; one finger then moves it and scrolls on past its edge", async () => {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 390, height: 844 } });
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?lang=en`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.locator('[data-tour="panel"]').click();
	const sheet = page.locator("[data-sheet-panel]");
	await expect(sheet).toBeVisible();
	await page.locator("[data-panel-tabbar]").getByRole("button", { name: "Files", exact: true }).click();
	const tree = sheet.locator(".omp-files-tree");
	await tree.getByRole("treeitem", { name: /README\.md/ }).click({ timeout: 15_000 });
	const area = sheet.locator("[data-pinch-area]");
	await expect(area).toBeVisible({ timeout: 10_000 });
	const box = await area.boundingBox();
	if (!box) throw new Error("no file area");
	const center = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 3) };
	const cdp = await context.newCDPSession(page);
	await cdp.send("Input.synthesizePinchGesture", { ...center, scaleFactor: 2, gestureSourceType: "touch" });
	await page.waitForTimeout(300);
	expect(await page.evaluate(() => window.visualViewport?.scale ?? 1), "the page").toBe(1);
	await expect(area).toHaveAttribute("data-pinch-zoomed", "true");
	const content = area.locator(":scope > div");
	const transform = () =>
		content.evaluate(node => {
			const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
			return { scale: matrix.a, x: matrix.e, y: matrix.f };
		});
	const zoomed = await transform();
	expect(zoomed.scale).toBeGreaterThan(1.6);
	await cdp.send("Input.synthesizeScrollGesture", {
		...center,
		xDistance: 0,
		yDistance: -60,
		gestureSourceType: "touch",
		speed: 400,
	});
	await page.waitForTimeout(300);
	expect((await transform()).y).toBeLessThan(zoomed.y - 20);
	// Another file starts at its own size.
	await sheet.getByRole("button", { name: "Back to files" }).click();
	await tree.getByRole("treeitem").nth(1).click();
	await expect(area).not.toHaveAttribute("data-pinch-zoomed", "true");
	await context.close();
});
