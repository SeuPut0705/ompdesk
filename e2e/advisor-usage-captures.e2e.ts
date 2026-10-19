import * as path from "node:path";
import { type Browser, chromium, devices, expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { captureTo } from "./harness";

// The advisor's spend on the dev harness (fixture `ADVISOR_USAGE`: $0.454, 18 calls, concern 2 · nit 1): the Run
// popover's one-line row (a bottom sheet on a phone) and Insights › This session's Advisor section, desktop 1280×800
// and phone 390 × light/dark × en/ko. Opt-in: OMP_GUI_ADVISOR_SHOTS=<dir> writes advisor-<shape>-<theme>-<lang>-<surface>.png.
// Behaviour is pinned by AdvisorUsageRow.test.tsx and the Insights test; this file only captures.

const captureDir = process.env.OMP_GUI_ADVISOR_SHOTS;

const SHAPES = [
	{ name: "desktop", preset: devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
	{ name: "390", preset: devices["Pixel 8"], viewport: { width: 390, height: 844 } },
] as const;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser;

test.beforeAll(async () => {
	if (!captureDir) return;
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

if (captureDir) {
	for (const shape of SHAPES) {
		for (const theme of ["light", "dark"] as const) {
			for (const lang of ["en", "ko"] as const) {
				test(`advisor usage ${shape.name} ${theme} ${lang}`, async () => {
					test.setTimeout(90_000);
					const context = await browser.newContext({ ...shape.preset, viewport: shape.viewport });
					const page = await context.newPage();
					page.on("pageerror", error => {
						throw error;
					});
					await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
					await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 45_000 });
					await page.waitForFunction(() => window.__stores?.session !== undefined, undefined, { timeout: 45_000 });
					await page.evaluate(() => window.__stores?.session.setState({ status: "ready", isStreaming: false }));
					const look = `${shape.name}-${theme}-${lang}`;

					await page.locator(".omp-composer-box [data-run-settings-trigger]").click();
					const row = page.locator("[data-advisor-usage]");
					await expect(row).toBeVisible();
					await row.scrollIntoViewIfNeeded();
					await page.waitForTimeout(400);
					await captureTo(captureDir, page, `advisor-${look}-run`);
					const info = row.locator("[data-setting-info]");
					await info.hover();
					await page.waitForTimeout(500);
					await captureTo(captureDir, page, `advisor-${look}-run-info`);
					await page.keyboard.press("Escape");

					await page.evaluate(() => {
						const ui = window.__stores?.ui.getState();
						if (ui && typeof ui === "object" && "openInsights" in ui && typeof ui.openInsights === "function")
							ui.openInsights("stats", "session");
					});
					const section = page.locator("[data-advisor-insights]");
					await expect(section).toBeVisible({ timeout: 15_000 });
					await section.scrollIntoViewIfNeeded();
					await page.waitForTimeout(400);
					await captureTo(captureDir, page, `advisor-${look}-insights`);
					await context.close();
				});
			}
		}
	}
}
