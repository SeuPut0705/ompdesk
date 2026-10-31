/**
 * Agent browsing's e2e pieces on stock's own code (preview-agent.e2e.ts, preview-agent-remote.e2e.ts): the fake omp's
 * bridge starts the relay server of the installed omp (`OMP_E2E_STOCK_RELAY`) and writes its address to
 * `OMP_E2E_RELAY_FILE`; stock's puppeteer-core connects through it the way the browser tool's relay mode does; a small
 * site gives the agent something to drive.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "@playwright/test";

const stockRoot = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
export const relayModule = path.join(stockRoot, "src/tools/browser/relay/server.ts");
export const puppeteerEntry = path.join(
	os.homedir(),
	".bun/install/global/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js",
);

/** Whether the installed omp and its puppeteer-core are there (a spec skips without them). */
export const stockRelayInstalled = () => existsSync(relayModule) && existsSync(puppeteerEntry);

export interface PuppeteerPage {
	url(): string;
	goto(url: string): Promise<unknown>;
	click(selector: string): Promise<void>;
	evaluate<T>(fn: () => T): Promise<T>;
	goBack(): Promise<unknown>;
	goForward(): Promise<unknown>;
	waitForNavigation(): Promise<unknown>;
	createCDPSession(): Promise<{ send(method: string, params?: object): Promise<unknown> }>;
}
export interface PuppeteerBrowser {
	connected: boolean;
	pages(): Promise<PuppeteerPage[]>;
	disconnect(): Promise<void>;
}
interface PuppeteerModule {
	connect(options: { browserURL: string; defaultViewport: null }): Promise<PuppeteerBrowser>;
}

/** The env that makes a fake omp's bridge start stock's relay and write its address to `relayFile`. */
export function relayEnv(relayFile: string): Record<string, string> {
	return { OMP_E2E_STOCK_RELAY: relayModule, OMP_E2E_RELAY_FILE: relayFile };
}

/**
 * The installed puppeteer-core is chosen at run time (it is not a dependency of this repo). Stock's relay answers
 * /json/version with 503 until the preview's hello lands, and stock's browser tool waits for that
 * (relay/probe.ts waitForRelayExtension) before it connects; so does this client.
 */
export async function connectRelay(relayFile: string): Promise<PuppeteerBrowser> {
	const puppeteer = (await import(pathToFileURL(puppeteerEntry).href)) as {
		default?: PuppeteerModule;
	} & PuppeteerModule;
	const { url } = JSON.parse(await fs.readFile(relayFile, "utf8")) as { url: string };
	await expect.poll(async () => (await fetch(new URL("/json/version", url))).status, { timeout: 30_000 }).toBe(200);
	return (puppeteer.default ?? puppeteer).connect({ browserURL: url, defaultViewport: null });
}

/** The pages the agent drives: `/` links to `/next`. */
export interface FixtureSite {
	/** The site's address, ending in `/`. */
	url: string;
	close(): Promise<void>;
}

/** The fixture site on `host` (a paired host's tab never loads a loopback address, so those specs name a LAN one). */
export async function fixtureSite(bind: string, host = bind): Promise<FixtureSite> {
	const server = createServer((request, response) => {
		response.writeHead(200, { "Content-Type": "text/html" });
		response.end(
			request.url === "/next"
				? "<!doctype html><title>Second page</title><h1>Clicked through</h1>"
				: '<!doctype html><title>Agent fixture</title><h1>Agent fixture</h1><a id="next" href="/next">Next</a>',
		);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, bind, () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No fixture server address");
	return {
		url: `http://${host}:${address.port}/`,
		close: async () => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			server.closeAllConnections();
			await closed.promise;
		},
	};
}

/** This computer's first non-loopback IPv4 address, or null (a host's tab shows no loopback page). */
export function lanAddress(): string | null {
	for (const addresses of Object.values(os.networkInterfaces()))
		for (const entry of addresses ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
	return null;
}
