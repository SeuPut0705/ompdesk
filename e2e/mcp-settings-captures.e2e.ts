import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, expect, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

// Settings › Tools & extensions › MCP on the dev harness (`dev-harness/fixture-mcp.ts`: a server off because only
// Codex's config declares it, one turned off by the user, one signed out, one also found in another tool's config).
// Behaviour is pinned by the component tests (McpServerCard.test.tsx); this only writes captures:
// OMP_GUI_MCP_SETTINGS_SHOTS=<dir>, files `<prefix>-<lang>-<theme>.png` for desktop 1280×800 and
// `<prefix>-<lang>-<theme>-phone.png` for a 390×844 phone (ko/en × light/dark).
// `OMP_GUI_MCP_SETTINGS_PREFIX` names the set (default `after`; use `before` on an old tree).

const captures = process.env.OMP_GUI_MCP_SETTINGS_SHOTS;
const prefix = process.env.OMP_GUI_MCP_SETTINGS_PREFIX ?? "after";

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

const SIZES = {
	desktop: { width: 1280, height: 800, isMobile: false, hasTouch: false },
	phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
} as const;

async function shoot(page: Page, name: string): Promise<void> {
	if (!captures) return;
	await fs.mkdir(captures, { recursive: true });
	await page.screenshot({ path: path.join(captures, `${prefix}-${name}.png`), animations: "disabled" });
}

async function openPage(lang: "en" | "ko", theme: "light" | "dark", size: keyof typeof SIZES): Promise<Page> {
	const { width, height, isMobile, hasTouch } = SIZES[size];
	const context = await browser.newContext({ viewport: { width, height }, isMobile, hasTouch, deviceScaleFactor: 2 });
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
	await page.waitForFunction(() => window.__stores?.ui !== undefined, undefined, { timeout: 45_000 });
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.evaluate(() => {
		// Through the store's own action: it also loads the Settings page.
		const ui = window.__stores?.ui?.getState();
		if (ui && typeof ui === "object" && "openSettings" in ui && typeof ui.openSettings === "function") {
			ui.openSettings("tools:mcp");
		}
	});
	await expect(page.getByText("codexDocs", { exact: true })).toBeVisible({ timeout: 30_000 });
	return page;
}

for (const lang of ["ko", "en"] as const) {
	for (const theme of ["light", "dark"] as const) {
		for (const size of ["desktop", "phone"] as const) {
			test(`mcp settings captures ${lang} ${theme} ${size}`, async () => {
				test.skip(!captures, "OMP_GUI_MCP_SETTINGS_SHOTS unset");
				const page = await openPage(lang, theme, size);
				await page.getByText("codexDocs", { exact: true }).scrollIntoViewIfNeeded();
				await shoot(page, size === "desktop" ? `${lang}-${theme}` : `${lang}-${theme}-${size}`);
				await page.context().close();
			});
		}
	}
}
