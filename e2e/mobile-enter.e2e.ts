import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Locator, type Page, test, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { variants } from "./harness";

// Enter on a touch keyboard (Chromium and WebKit device emulation on the dev harness): the return key adds a line
// and only the Send button sends, a physical keyboard's key (an arrow, ⌘↵, Shift+Enter) gives the desktop's Enter back,
// and a Korean composition's Enter never sends.

test.describe.configure({ retries: 1 });

let server: ViteDevServer | undefined;
let origin = "";
// Each engine starts on its first test, so the Chromium cases run on a machine without Playwright's WebKit.
let chromiumBrowser: Browser | undefined;
let webkitBrowser: Browser | undefined;

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
	await chromiumBrowser?.close();
	await webkitBrowser?.close();
	await server?.close();
});

type Lang = "en" | "ko";

async function openPhone(engine: "chromium" | "webkit", lang: Lang): Promise<Page> {
	if (engine === "chromium") chromiumBrowser ??= await chromium.launch();
	else webkitBrowser ??= await webkit.launch();
	const browser = engine === "chromium" ? chromiumBrowser : webkitBrowser;
	if (!browser) throw new Error(`${engine} did not start`);
	const context = await browser.newContext({
		...devices[engine === "chromium" ? "Pixel 8" : "iPhone 15"],
	});
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=light&lang=${lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.composer !== undefined, undefined, { timeout: 45_000 });
	await expect(page.locator("html")).toHaveAttribute("data-input", "touch");
	await page.evaluate(() => window.__stores?.session.setState({ status: "ready", isStreaming: false }));
	return page;
}

const field = (page: Page): Locator => page.locator("textarea[data-composer-input]");
const draft = (page: Page): Promise<string> =>
	page.evaluate(() => (window.__stores?.composer.getState() as { draft: string } | undefined)?.draft ?? "");
const prompts = (page: Page): Promise<number> =>
	page.evaluate(() => (window.__harness?.unhandled ?? []).filter(entry => entry === "rpc:prompt").length);

for (const engine of ["chromium", "webkit"] as const)
	for (const lang of variants<Lang>(["en", "ko"], () => true))
		test.describe(`touch Enter · ${engine} · ${lang}`, () => {
			test("Enter adds a line, the return key says so, and Send sends", async () => {
				const page = await openPhone(engine, lang);
				try {
					await expect(field(page)).toHaveAttribute("enterkeyhint", "enter");
					await field(page).click();
					await page.keyboard.type("first");
					await page.keyboard.press("Enter");
					await page.keyboard.type("second");
					await expect.poll(() => draft(page)).toBe("first\nsecond");
					expect(await prompts(page)).toBe(0);
					await page.getByRole("button", { name: lang === "en" ? "Send" : "보내기" }).tap();
					await expect.poll(() => draft(page)).toBe("");
					await expect.poll(() => prompts(page)).toBe(1);
				} finally {
					await page.context().close();
				}
			});

			test("a physical keyboard's key makes Enter send; Shift+Enter keeps its newline", async () => {
				const page = await openPhone(engine, lang);
				try {
					await field(page).click();
					await page.keyboard.type("typed");
					await page.keyboard.press("Shift+Enter");
					await page.keyboard.type("again");
					await expect.poll(() => draft(page)).toBe("typed\nagain");
					await page.keyboard.press("Enter");
					await expect.poll(() => draft(page)).toBe("");
				} finally {
					await page.context().close();
				}
			});
		});
