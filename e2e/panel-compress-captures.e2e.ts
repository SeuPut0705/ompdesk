/**
 * Opt-in captures of the side panel and the views it no longer holds (`OMP_GUI_PANEL_COMPRESS_SHOTS=<dir>`, optional
 * `OMP_GUI_PANEL_COMPRESS_LABEL=<prefix>`), on the dev harness (`vite.harness.config.ts`) in a wide desktop window ×
 * light/dark × en/ko: the panel with its header (and, where it still has one, the ⋮ View options list open), then
 * each secondary view where it lives: in the panel before, in its sheet (Background tasks, Plan document, Session
 * tree, Logs, Work tree) or its new home (Memory → Settings › Memory) after. Writes `<label>-<view>-<theme>-<lang>.png`.
 * Behaviour is covered by `ViewSheetHost.test.tsx`, `PanelContainer` cases and `retired-prefs.test.ts`.
 */
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const SHOTS = process.env.OMP_GUI_PANEL_COMPRESS_SHOTS;
const LABEL = process.env.OMP_GUI_PANEL_COMPRESS_LABEL ?? "after";

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

const VIEWS = ["jobs", "plan", "logs", "queue", "tree", "work", "memory"] as const;

/** Calls a ui store method; false when this build has no such method. */
function ui(page: Page, method: string, ...args: unknown[]): Promise<boolean> {
	return page.evaluate(
		({ method, args }) => {
			const state = (window.__stores?.ui?.getState() ?? {}) as Record<string, unknown>;
			const run = state[method];
			if (typeof run !== "function") return false;
			(run as (...rest: unknown[]) => unknown)(...args);
			return true;
		},
		{ method, args },
	);
}

if (SHOTS) {
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
			test(`side panel ${theme} ${lang}`, async () => {
				test.setTimeout(180_000);
				if (!browser) throw new Error("no browser");
				const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
				const page = await context.newPage();
				await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}&board=busy`);
				await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
				await page.waitForFunction(() => window.__stores?.ui !== undefined, undefined, { timeout: 45_000 });
				await fs.mkdir(SHOTS, { recursive: true });
				const file = (name: string) => path.join(SHOTS, `${LABEL}-${name}-${theme}-${lang}.png`);
				const close = async () => {
					await page.keyboard.press("Escape");
					await page.evaluate(() => window.__stores?.ui?.setState({ panelVisible: false, viewSheet: null }));
					await page.waitForTimeout(300);
				};

				await ui(page, "setPanelTab", "diff");
				await page.waitForTimeout(700);
				const more = page.getByRole("button", { name: /View options|보기 옵션/ });
				if (await more.isVisible().catch(() => false)) await more.click();
				await page.waitForTimeout(400);
				await page.screenshot({ path: file("panel") });
				await close();

				for (const view of VIEWS) {
					const sheet =
						view === "jobs" || view === "plan" || view === "logs" || view === "tree" || view === "work";
					if (sheet && (await ui(page, "openViewSheet", view))) {
						// After: the view in its sheet.
					} else if (view === "memory" && LABEL !== "before") {
						await ui(page, "openSettings", "memory");
					} else if (view === "queue" && LABEL !== "before") {
						continue;
					} else {
						await ui(page, "setPanelTab", view);
					}
					await page.waitForTimeout(900);
					await page.screenshot({ path: file(view) });
					await close();
					await ui(page, "closeDestination");
				}
				await context.close();
			});
}
