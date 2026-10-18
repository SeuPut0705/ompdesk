/**
 * Playwright driver for the toolbar prototypes (throwaway; run with `bun <this file> <smoke|sheets|measure|popovers>`).
 * Serves proto-toolbar.html with Vite from vite.harness.config.ts, the way e2e/mobile-shell.e2e.ts serves the harness.
 */

import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

const ROOT = path.resolve(import.meta.dirname, "../../../../..");
const OUT = "/tmp/composer-best/prototypes/toolbar";

export const WIDTHS = [1000, 760, 560, 420, 340] as const;
export const STATES = ["idle", "typing", "running", "running-draft", "plan-goal"] as const;
export const VARIANTS = ["base", "a", "b", "c"] as const;
export const THEMES = ["light", "dark"] as const;
export const LANGS = ["en", "ko"] as const;

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

export interface Harness {
	origin: string;
	server: ViteDevServer;
	close: () => Promise<void>;
}

export async function startVite(): Promise<Harness> {
	const port = await freePort();
	const server = await createServer({
		configFile: path.join(ROOT, "vite.harness.config.ts"),
		server: { host: "127.0.0.1", port, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	return { origin: `http://127.0.0.1:${port}`, server, close: () => server.close() };
}

export interface Params {
	variant: string;
	state: string;
	width: number;
	theme: string;
	lang: string;
	model?: "long";
	shell?: boolean;
}

export function urlFor(origin: string, p: Params): string {
	const q = new URLSearchParams({
		variant: p.variant,
		state: p.state,
		width: String(p.width),
		theme: p.theme,
		lang: p.lang,
	});
	if (p.model) q.set("model", p.model);
	if (p.shell) {
		q.set("shell", "tablet-landscape");
		q.set("input", "touch");
	}
	return `${origin}/proto-toolbar.html?${q}`;
}

let warmed = false;

export async function open(page: Page, origin: string, p: Params): Promise<void> {
	const url = urlFor(origin, p);
	// A cold Vite reloads the page once or twice while it optimizes dependencies: let that settle first.
	if (!warmed) {
		await page.goto(url);
		await page.waitForTimeout(6000);
		warmed = true;
	}
	for (let attempt = 0; attempt < 4; attempt++) {
		await page.goto(url);
		try {
			const expected = p.variant === "all" ? 4 : 1;
			await page.waitForFunction(count => document.querySelectorAll("[data-proto-toolbar]").length >= count, expected, { timeout: 20000 });
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(150);
			return;
		} catch {
			// try again
		}
	}
	throw new Error(`page never became ready: ${url}`);
}

async function smoke(): Promise<void> {
	const harness = await startVite();
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
		const problems: string[] = [];
		page.on("console", message => {
			if (message.type() === "error" || message.type() === "warning") problems.push(`${message.type()}: ${message.text()}`);
		});
		page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
		await fs.mkdir(OUT, { recursive: true });
		await open(page, harness.origin, { variant: "all", state: "idle", width: 760, theme: "light", lang: "en" });
		await page.screenshot({ path: path.join(OUT, "smoke.png"), fullPage: true });
		console.log(problems.length === 0 ? "no console problems" : problems.join("\n"));
	} finally {
		await browser.close();
		await harness.close();
	}
}

if (import.meta.main) {
	const mode = process.argv[2] ?? "smoke";
	if (mode === "smoke") await smoke();
	else {
		const module = await import(`./capture-${mode}.mts`);
		await module.run();
	}
}
