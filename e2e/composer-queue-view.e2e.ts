import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { captureTo } from "./harness";
import { composerGeometry, seedPaused, seedQueue } from "./queue-harness";

// The composer's queue on the dev harness at the three widths the design is judged at (desktop 1280×900, tablet 834,
// phone 390) in both themes and languages: one pill whatever the count, a floating list, the field taking an edit
// over, the paused row. Each state is asserted (the composer never moves while messages queue) and, with
// OMP_GUI_QUEUE_CAPTURES=<dir>, captured as queue-<viewport>-<theme>-<lang>-<state>.png.

const captureDir = process.env.OMP_GUI_QUEUE_CAPTURES;

const VIEWPORTS = [
	{ name: "desktop-1280", preset: devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, phone: false },
	{ name: "tablet-834", preset: devices["iPad Pro 11"], viewport: { width: 834, height: 1194 }, phone: false },
	{ name: "phone-390", preset: devices["iPhone 15"], viewport: { width: 390, height: 844 }, phone: true },
] as const;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser;

test.beforeAll(async () => {
	server = await createServer({
		configFile: path.resolve("vite.harness.config.ts"),
		server: { host: "127.0.0.1", port: 0, strictPort: false },
		logLevel: "error",
	});
	await server.listen();
	const address = server.httpServer?.address();
	origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	browser = await chromium.launch();
});

test.afterAll(async () => {
	await browser?.close();
	await server?.close();
});

async function open(look: { theme: "light" | "dark"; lang: "en" | "ko" }, shape: (typeof VIEWPORTS)[number]) {
	const context = await browser.newContext({ ...shape.preset, viewport: shape.viewport });
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${look.theme}&lang=${look.lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	return page;
}

async function shot(page: Page, shape: string, look: string, state: string): Promise<void> {
	await page.waitForTimeout(450);
	await captureTo(captureDir, page, `queue-${shape}-${look}-${state}`);
}

for (const shape of VIEWPORTS) {
	for (const theme of ["light", "dark"] as const) {
		for (const lang of ["en", "ko"] as const) {
			test(`${shape.name} ${theme} ${lang}: the queue is a pill and a list that float, edit takes the field, a pause is one row`, async () => {
				test.setTimeout(90_000);
				const page = await open({ theme, lang }, shape);
				const look = `${theme}-${lang}`;
				// The baseline is a running turn with nothing queued: queuing must change nothing from there.
				await seedQueue(page, { steering: [], followUp: [] });
				const idle = await composerGeometry(page);
				const pill = page.locator("[data-queue-pill]");
				const popover = page.locator("[data-queue-popover]");
				const named = (en: string, ko: string) => (lang === "en" ? en : ko);

				await seedQueue(page, { steering: [], followUp: ["f2"] });
				await expect(pill).toBeVisible();
				expect(await composerGeometry(page)).toEqual(idle);
				await shot(page, shape.name, look, "queue1");

				await seedQueue(page, { steering: ["s1", "s2"], followUp: ["f1", "f2"] });
				await expect(pill).toBeVisible();
				expect(await composerGeometry(page)).toEqual(idle);
				await shot(page, shape.name, look, "queue4");

				await seedQueue(page, {
					steering: ["s1", "s2"],
					followUp: ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"],
				});
				expect(await composerGeometry(page)).toEqual(idle);
				await pill.click();
				await expect(popover).toBeVisible();
				await expect(popover.locator("[data-lane-head]")).toHaveCount(2);
				await expect(popover.locator("[data-queue-policy]")).toContainText(named("Steers arrive", "추가 지시는"));
				expect(await composerGeometry(page)).toEqual(idle);
				await shot(page, shape.name, look, "queue10-open");

				// Edit queued: the field holds the message under a banner, Send is a check, the pill is gone.
				await popover
					.getByRole("button", { name: named("Edit: Also cover the 429", "편집: Also cover the 429") })
					.click();
				await expect(page.locator("[data-queue-edit-banner]")).toBeVisible();
				await expect(pill).toHaveCount(0);
				await expect(page.locator("textarea[data-composer-input]")).toHaveValue(
					"Also cover the 429 case with a test",
				);
				await expect(
					page.getByRole("button", { name: named("Save queued message", "대기 메시지 저장") }),
				).toBeVisible();
				await shot(page, shape.name, look, "edit-queued");
				await page.locator("textarea[data-composer-input]").press("Escape");
				await expect(page.locator("[data-queue-edit-banner]")).toHaveCount(0);
				await expect(page.locator("textarea[data-composer-input]")).toHaveValue("");

				// Paused after Stop: one 36 px row of chips, nothing overflows.
				await seedQueue(page, { steering: [], followUp: [], running: false });
				await seedPaused(page, [
					{ id: "s1", lane: "steering" },
					{ id: "f1", lane: "followUp" },
					{ id: "f2", lane: "followUp" },
				]);
				const paused = page.locator("[data-restored-queue]");
				await expect(paused).toBeVisible();
				expect(Math.round((await paused.boundingBox())?.height ?? 0)).toBe(36);
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
				await shot(page, shape.name, look, "paused-after-stop");
				await page.context().close();
			});
		}
	}
}
