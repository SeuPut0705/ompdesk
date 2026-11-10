import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { THEME_NAMES } from "../src/shared/theme-names";

// Every theme on every surface of the dev harness, for theme work (settings-layout-look.md › Themes): the transcript
// with a code block, a diff, a Mermaid figure and a table (`?stress=1`), the sidebar, Settings › Appearance, the
// terminal, the command palette, a menu, and a 390×844 phone. Captures only; contrast and identity are pinned by
// themes.contrast.test.ts and theme-fidelity.test.ts. OMPDESK_THEME_SHOTS=<dir>, files `<prefix>-<theme>-<surface>.png`;
// OMPDESK_THEME_PREFIX names the set (default `after`), OMPDESK_THEMES narrows it (comma-separated ids).

const captures = process.env.OMPDESK_THEME_SHOTS;
const prefix = process.env.OMPDESK_THEME_PREFIX ?? "after";
const only = process.env.OMPDESK_THEMES?.split(",").filter(Boolean);
const themes = THEME_NAMES.filter(name => !only || only.includes(name));

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser;

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const probe = createNetServer();
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", () => {
		const address = probe.address();
		probe.close(() => {
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("no port"));
		});
	});
	return promise;
}

test.beforeAll(async () => {
	if (!captures) return;
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

async function shoot(page: Page, name: string): Promise<void> {
	if (!captures) return;
	await fs.mkdir(captures, { recursive: true });
	await page.waitForTimeout(250);
	await page.screenshot({ path: path.join(captures, `${prefix}-${name}.png`), animations: "disabled" });
}

async function open(theme: string, phone: boolean): Promise<Page> {
	const context = await browser.newContext({
		viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
		isMobile: phone,
		hasTouch: phone,
		deviceScaleFactor: 2,
	});
	const page = await context.newPage();
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=en&stress=1&rail=all`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 45_000 });
	await page.waitForFunction(() => window.__stores?.ui !== undefined, undefined, { timeout: 45_000 });
	await expect(page.locator("html")).toHaveAttribute("data-theme-name", theme);
	return page;
}

function ui(page: Page, action: string, ...args: unknown[]): Promise<void> {
	return page.evaluate(
		([name, rest]) => {
			const state = window.__stores?.ui?.getState() as Record<string, unknown> | undefined;
			const fn = state?.[name as string];
			if (typeof fn === "function") fn(...(rest as unknown[]));
		},
		[action, args] as const,
	);
}

for (const theme of themes) {
	test(`theme captures ${theme} wide`, async () => {
		test.skip(!captures, "OMPDESK_THEME_SHOTS unset");
		test.setTimeout(120_000);
		const page = await open(theme, false);
		const mermaid = page.locator('[data-figure="mermaid"]').first();
		await expect(mermaid.locator("svg").last()).toBeVisible({ timeout: 30_000 });
		await page.locator("table").first().scrollIntoViewIfNeeded();
		await shoot(page, `${theme}-chat`);
		await mermaid.scrollIntoViewIfNeeded();
		await shoot(page, `${theme}-figure`);

		await ui(page, "setPanelTab", "terminal");
		await page.waitForTimeout(600);
		await shoot(page, `${theme}-terminal`);

		await ui(page, "openCommandPalette");
		await expect(page.getByRole("dialog")).toBeVisible();
		await shoot(page, `${theme}-palette`);
		await page.keyboard.press("Escape");

		await page.locator(".omp-sidebar-session-row").first().click({ button: "right" });
		await expect(page.getByRole("menu")).toBeVisible();
		await shoot(page, `${theme}-menu`);
		await page.keyboard.press("Escape");

		await ui(page, "openSettings", "appearance");
		await expect(page.locator('[data-theme-option="system"]')).toBeVisible({ timeout: 30_000 });
		await shoot(page, `${theme}-settings`);
		await page.context().close();
	});

	test(`theme captures ${theme} phone`, async () => {
		test.skip(!captures, "OMPDESK_THEME_SHOTS unset");
		test.setTimeout(120_000);
		const page = await open(theme, true);
		await page.locator('[data-figure="mermaid"] svg').first().waitFor({ timeout: 30_000 });
		await page.locator("table").first().scrollIntoViewIfNeeded();
		await shoot(page, `${theme}-phone-chat`);
		await page.locator('[data-figure="mermaid"]').first().scrollIntoViewIfNeeded();
		await shoot(page, `${theme}-phone-figure`);
		await ui(page, "openSettings", "appearance");
		await expect(page.locator('[data-theme-option="system"]')).toBeVisible({ timeout: 30_000 });
		await shoot(page, `${theme}-phone-settings`);
		await page.context().close();
	});
}
