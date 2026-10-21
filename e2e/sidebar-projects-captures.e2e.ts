/**
 * Captures of the sidebar's project list (src/main/sidebar-projects.ts): a project with no session keeps its header and
 * its +, a project whose folder is gone is dimmed and says so, and Remove from sidebar takes one out. Opt-in:
 * `OMP_GUI_SIDEBAR_PROJECTS=<dir>` writes `desktop-<state>-<theme>-<lang>.png` from the dev harness (`?projects=1`,
 * `src/renderer/dev-harness/fixture.ts` `projectsFixture`). The rules themselves are pinned by `Sidebar.test.tsx`
 * and `src/main/sidebar-projects.test.ts`.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const CAPTURES = process.env.OMP_GUI_SIDEBAR_PROJECTS;

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

async function openHarness(theme: "light" | "dark", lang: "en" | "ko"): Promise<Page> {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}&projects=1`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	return page;
}

async function capture(page: Page, state: string, theme: string, lang: string): Promise<void> {
	if (!CAPTURES) return;
	await fs.mkdir(CAPTURES, { recursive: true });
	const file = path.join(CAPTURES, `desktop-${state}-${theme}-${lang}.png`);
	// The group menu opens beside the sidebar: its capture takes the page's left edge, not the sidebar alone.
	if (state === "menu") await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 560, height: 860 } });
	else await page.locator(".omp-session-sidebar").first().screenshot({ path: file });
}

if (CAPTURES) {
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

	for (const theme of ["light", "dark"] as const)
		for (const lang of ["en", "ko"] as const)
			test(`projects outlive their sessions in the sidebar (${theme} ${lang})`, async () => {
				const page = await openHarness(theme, lang);
				const empty = page.locator('[data-workspace-group="/Users/dev/projects/api"]');
				const missing = page.locator('[data-workspace-group="/Users/dev/projects/old-prototype"]');
				await expect(empty).toBeVisible();
				await expect(empty.locator("[data-sidebar-group-new]")).toBeEnabled();
				await expect(missing).toHaveAttribute("data-project-missing", "");
				await expect(missing.locator("[data-sidebar-group-new]")).toBeDisabled();
				await capture(page, "listed", theme, lang);

				await empty.hover();
				await empty.locator(".omp-sidebar-project-menu").click();
				// Captured once its fade-in ended.
				await page
					.getByRole("menu")
					.evaluate(menu =>
						Promise.all(menu.getAnimations({ subtree: true }).map(animation => animation.finished)),
					);
				await capture(page, "menu", theme, lang);
				await page
					.getByRole("menuitem", { name: lang === "ko" ? "사이드바에서 제거" : "Remove from sidebar" })
					.click();
				await expect(empty).toHaveCount(0);
				await capture(page, "removed", theme, lang);
				await page.context().close();
			});
}
