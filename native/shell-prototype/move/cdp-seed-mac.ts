// bun cdp-seed.ts <port>: in the released app's own page, save a stand-in update token through its own IPC
// (main encrypts it with safeStorage) and write file:// Local Storage keys. Prints one JSON line.
import { chromium } from "playwright";
const port = process.argv[2];
const token = process.env.STAND_IN_TOKEN ?? "ghp_STANDIN_not_a_real_token_0123456789";
let browser;
for (let i = 0; i < 120 && !browser; i++) {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 }).catch(() => undefined);
	if (!browser) await new Promise(r => setTimeout(r, 500));
}
if (!browser) throw new Error("no CDP endpoint");
let page;
for (let i = 0; i < 60 && !page; i++) {
	page = browser.contexts().flatMap(c => c.pages()).find(p => /index\.html/.test(p.url()));
	if (!page) await new Promise(r => setTimeout(r, 500));
}
if (!page) throw new Error("no app page");
await page.waitForFunction(() => typeof (window as any).omp?.updater?.saveAuth === "function", null, { timeout: 30_000 });
const out = await page.evaluate(async t => {
	const saved = await (window as any).omp.updater.saveAuth(t);
	localStorage.setItem("ompdesk.seed.draft", "a draft typed in Electron");
	localStorage.setItem("ompdesk.seed.korean", "한국어 초안 ✓");
	localStorage.setItem("ompdesk.seed.large", "x".repeat(200000));
	return { saved, origin: location.origin, href: location.href, keys: localStorage.length, auth: await (window as any).omp.updater.authInfo() };
}, token);
console.log(JSON.stringify(out));
process.exit(0); // no browser.close(): it would send Browser.close
