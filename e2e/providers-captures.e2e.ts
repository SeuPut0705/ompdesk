import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { chromium, devices, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { hitSizes } from "./harness";

// Settings › Models & accounts › Providers & accounts on the dev harness with several Claude and ChatGPT accounts
// (`?accounts=1`, src/renderer/dev-harness/fixture-accounts.ts): the grouped list, desktop and phone (390 px), en and
// ko, each checked for overflow and for the add button's touch target. Runs only with OMP_GUI_PROVIDERS_SHOTS=<dir>,
// which also receives the captures (`providers-<size>-<lang>.png`).

const SHOTS = process.env.OMP_GUI_PROVIDERS_SHOTS;
test.skip(!SHOTS, "set OMP_GUI_PROVIDERS_SHOTS=<dir> to capture");

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

const SIZES = {
	desktop: { viewport: { width: 1280, height: 1500 } },
	phone: { ...devices["Pixel 7"], viewport: { width: 390, height: 1700 } },
} as const;

async function openModels(page: Page, phone: boolean): Promise<void> {
	const menu = page.locator("button:visible:has(svg.lucide-menu)").first();
	if (phone) {
		await menu.click();
		await page.locator('[data-drawer] [data-destination="settings"]').click();
	} else {
		await page.locator('.omp-session-sidebar [data-destination="settings"]').click();
	}
	const settings = page.locator("[data-settings-page]");
	await expect(settings).toBeVisible();
	await page.locator('[data-settings-section="models"]').click();
	await expect(page.locator("[data-provider-list]")).toBeVisible();
}

for (const [size, options] of Object.entries(SIZES))
	for (const lang of ["en", "ko"] as const)
		test(`providers grouped by company: ${size} ${lang}`, async () => {
			test.setTimeout(120_000);
			const browser = await chromium.launch();
			const context = await browser.newContext(options);
			const page = await context.newPage();
			try {
				page.on("pageerror", error => {
					throw error;
				});
				await page.goto(`${origin}/harness.html?theme=light&lang=${lang}&accounts=1`);
				await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
				await openModels(page, size === "phone");
				const list = page.locator("[data-provider-list]");
				await expect(list.locator("[data-provider-row]")).toHaveCount(5);
				await expect(list.locator('[data-provider-row="anthropic"] [data-provider-account]')).toHaveCount(4);
				await expect(list.locator('[data-provider-row="openai-codex"] [data-provider-account]')).toHaveCount(3);
				await expect(list.locator('[data-provider-row="openrouter"] [data-provider-add]')).toHaveCount(0);
				const adds = list.locator("[data-provider-add]");
				await expect(adds).toHaveCount(3);
				const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
				expect(overflow).toBeLessThanOrEqual(0);
				if (size === "phone") {
					for (const { hit, label } of await hitSizes(adds)) {
						expect(hit.height, label).toBeGreaterThanOrEqual(24);
					}
				}
				await page.waitForTimeout(400);
				await fs.mkdir(SHOTS ?? "", { recursive: true });
				await page.locator("#settings-models-accounts").screenshot({
					animations: "disabled",
					path: path.join(SHOTS ?? "", `providers-${size}-${lang}.png`),
				});
			} finally {
				await browser.close();
			}
		});
