import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// Agent browsing in the Preview panel, end to end on stock's own pieces: the
// fake omp's bridge starts stock's relay server (tools/browser/relay/server.ts
// from the installed omp), the app's preview joins it as the relay extension,
// and stock's puppeteer-core connects through it the way the browser tool's
// relay mode does. The user watches the banner, then takes over.
// OMP_GUI_PREVIEW_AGENT_CAPTURES=<dir> keeps the panel captures.

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const relayModule = path.join(stockRoot, "src/tools/browser/relay/server.ts");
const puppeteerEntry = path.join(
	os.homedir(),
	".bun/install/global/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js",
);
const captures = process.env.OMP_GUI_PREVIEW_AGENT_CAPTURES;

interface PuppeteerPage {
	url(): string;
	goto(url: string): Promise<unknown>;
	click(selector: string): Promise<void>;
	evaluate<T>(fn: () => T): Promise<T>;
	waitForNavigation(): Promise<unknown>;
}
interface PuppeteerBrowser {
	connected: boolean;
	pages(): Promise<PuppeteerPage[]>;
	disconnect(): Promise<void>;
}
interface PuppeteerModule {
	connect(options: { browserURL: string; defaultViewport: null }): Promise<PuppeteerBrowser>;
}

for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const) {
	test(`the agent drives the visible preview through stock's relay and the user takes over (${language}-${theme})`, async () => {
		const entry = puppeteerEntry;
		test.skip(!existsSync(relayModule) || !existsSync(entry), "needs the installed omp and its puppeteer-core");
		test.setTimeout(120_000);
		const server = createServer((request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end(
				request.url === "/next"
					? "<!doctype html><title>Second page</title><h1>Clicked through</h1>"
					: '<!doctype html><title>Agent fixture</title><h1>Agent fixture</h1><a id="next" href="/next">Next</a>',
			);
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture server address");
		const site = `http://127.0.0.1:${address.port}/`;
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-preview-agent-"));
		const desktop = path.join(profile, "desktop");
		const project = path.join(profile, "project");
		const agent = path.join(profile, "agent");
		const relayFile = path.join(profile, "relay.json");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(project), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
		const env = {
			...process.env,
			OMP_GUI_HEADLESS: "1",
			PI_CODING_AGENT_DIR: agent,
			OMP_GUI_OMP: await fixtureOmp(profile),
			OMP_E2E_STOCK_RELAY: relayModule,
			OMP_E2E_RELAY_FILE: relayFile,
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		// The installed puppeteer-core is chosen at run time; it is not a dependency of this repo.
		const puppeteer = (await import(pathToFileURL(entry).href)) as { default?: PuppeteerModule } & PuppeteerModule;
		const connect = (puppeteer.default ?? puppeteer).connect;
		const app = await electron.launch({
			args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
			env,
		});
		let browser: PuppeteerBrowser | null = null;
		try {
			const page = await app.firstWindow();
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			const aside = page.locator("aside[data-docked]");
			await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
			await aside.getByRole("button", { name: language === "ko" ? "미리보기" : "Preview", exact: true }).click();
			const allow = aside.getByRole("button", {
				name: language === "ko" ? "에이전트가 이 페이지를 쓰게 하기" : "Let the agent use this page",
				exact: true,
			});
			await allow.click();
			const banner = aside.locator("[data-preview-agent]");
			await expect(banner).toHaveAttribute("data-preview-agent", "waiting");
			if (captures) {
				await fs.mkdir(captures, { recursive: true });
				await aside.screenshot({
					animations: "disabled",
					path: path.join(captures, `agent-${language}-${theme}-waiting.png`),
				});
			}

			const relay = JSON.parse(await fs.readFile(relayFile, "utf8")) as { url: string };
			// The banner shows "waiting" as soon as main opens the relay socket; stock's relay answers
			// /json/version with 503 until the preview's hello lands, and stock's browser tool waits for
			// that (relay/probe.ts waitForRelayExtension) before it connects. So does this client.
			await expect.poll(async () => (await fetch(new URL("/json/version", relay.url))).status).toBe(200);
			browser = await connect({ browserURL: relay.url, defaultViewport: null });
			const pages = await browser.pages();
			expect(pages).toHaveLength(1);
			const driven = pages[0];
			await driven.goto(site);
			await expect(page.locator("[data-preview-status]")).toHaveText("Agent fixture");
			await expect(banner).toHaveAttribute("data-preview-agent", "attached");
			expect(await driven.evaluate(() => document.querySelector("h1")?.textContent)).toBe("Agent fixture");
			await Promise.all([driven.waitForNavigation(), driven.click("#next")]);
			await expect(page.locator("[data-preview-status]")).toHaveText("Second page");
			await expect(
				page.getByRole("textbox", { name: language === "ko" ? "미리보기 URL" : "Preview URL" }),
			).toHaveValue(`${site}next`);
			// The preview stays on the web: a file URL is refused before the page sees it.
			await expect(driven.goto("file:///etc/hosts")).rejects.toThrow(/http\(s\)/);
			const security = await app.evaluate(async ({ webContents }) => {
				const child = webContents.getAllWebContents().find(contents => contents.getTitle() === "Second page");
				if (!child) throw new Error("Missing native preview contents");
				return child.executeJavaScript("({ node: typeof require, ipc: typeof window.omp })");
			});
			expect(security).toEqual({ node: "undefined", ipc: "undefined" });
			await expect(banner).toContainText(/Page\.|Runtime\.|Input\.|DOM\./);
			if (captures) {
				await aside.screenshot({
					animations: "disabled",
					path: path.join(captures, `agent-${language}-${theme}-driving.png`),
				});
				// Below 1000 px the side panel is a sheet and closing it ends the agent's hold; the narrowest docked width.
				await page.setViewportSize({ width: 1000, height: 900 });
				await page.screenshot({
					animations: "disabled",
					path: path.join(captures, `agent-${language}-${theme}-1000.png`),
				});
			}

			await banner
				.getByRole("button", { name: language === "ko" ? "직접 조작하기" : "Take over", exact: true })
				.click();
			await expect(banner).toHaveCount(0);
			const live = browser;
			await expect.poll(() => live.connected, { timeout: 10_000 }).toBe(false);
			await expect(allow).toBeVisible();
			await expect(page.locator("[data-preview-status]")).toHaveText("Second page");
		} finally {
			await browser?.disconnect().catch(() => {});
			await exitApp(app);
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
