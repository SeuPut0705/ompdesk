// bun measure/playwright-attach.ts <port> <out.png>: Playwright attaches over the debugging port, finds the app page,
// reads it and drives it (a click on the sidebar, a key press), then screenshots it. Prints one JSON line.
import { chromium } from "playwright";

const [port, png] = [process.argv[2], process.argv[3]];
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15_000 });
const pages = browser.contexts().flatMap(context => context.pages());
const page = pages.find(p => /index\.html/.test(p.url())) ?? pages[0];
const facts = await page.evaluate(() => ({
	title: document.title,
	omp: typeof (window as unknown as { omp?: unknown }).omp,
	platform: document.documentElement.dataset.platform,
	buttons: document.querySelectorAll("button").length,
}));
const button = page.locator("button:visible").first();
await button.click({ timeout: 5000 }).catch(() => {});
await page.keyboard.press("Escape");
await page.screenshot({ path: png });
console.log(JSON.stringify({ ok: facts.omp === "object" && facts.buttons > 0, urls: pages.map(p => p.url()), ...facts, png }));
// No browser.close(): over CDP it sends Browser.close, which quits the shell itself.
process.exit(0);
