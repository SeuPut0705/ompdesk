// bun cdp-seed-mac.ts <port> [read]: in the released app's own page, save a stand-in update token through its own IPC
// (main encrypts it with safeStorage) and write file:// Local Storage keys. Prints one JSON line.
import { type Browser, chromium, type Page } from "playwright";

const mode = process.argv[3] ?? "seed";
const port = process.argv[2];
const token = process.env.STAND_IN_TOKEN ?? "ghp_STANDIN_not_a_real_token_0123456789";
let browser: Browser | undefined;
for (let i = 0; i < 120 && !browser; i++) {
	browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 }).catch(() => undefined);
	if (!browser) await new Promise(r => setTimeout(r, 500));
}
if (!browser) throw new Error("no CDP endpoint");
let page: Page | undefined;
/** What the seed reads of the released app's page: its `window.omp` updater calls. */
type SeedWindow = { omp?: { updater?: { saveAuth(token: string): Promise<unknown>; authInfo(): Promise<unknown> } } };
for (let i = 0; i < 60 && !page; i++) {
	page = browser
		.contexts()
		.flatMap(c => c.pages())
		.find(p => /index\.html|app:\/\/ompdesk/.test(p.url()));
	if (!page) await new Promise(r => setTimeout(r, 500));
}
if (!page) throw new Error("no app page");
await page.waitForFunction(() => typeof (window as unknown as SeedWindow).omp?.updater?.saveAuth === "function", null, {
	timeout: 30_000,
});
if (mode === "read") {
	// The shell's page after the move: the token the released app saved is readable through the shell's safeStorage,
	// and the file:// Local Storage the shell imported is there under app://ompdesk.
	await page.waitForFunction(
		() => typeof (window as unknown as SeedWindow).omp?.updater?.authInfo === "function",
		null,
		{
			timeout: 60_000,
		},
	);
	const read = await page.evaluate(async () => ({
		href: location.href,
		auth: await (window as unknown as SeedWindow).omp?.updater?.authInfo(),
		draft: localStorage.getItem("ompdesk.seed.draft"),
		korean: localStorage.getItem("ompdesk.seed.korean"),
		large: (localStorage.getItem("ompdesk.seed.large") ?? "").length,
	}));
	console.log(JSON.stringify(read));
	process.exit(0);
}
const out = await page.evaluate(async t => {
	const saved = await (window as unknown as SeedWindow).omp?.updater?.saveAuth(t);
	localStorage.setItem("ompdesk.seed.draft", "a draft typed in Electron");
	localStorage.setItem("ompdesk.seed.korean", "한국어 초안 ✓");
	localStorage.setItem("ompdesk.seed.large", "x".repeat(200000));
	return {
		saved,
		origin: location.origin,
		href: location.href,
		keys: localStorage.length,
		auth: await (window as unknown as SeedWindow).omp?.updater?.authInfo(),
	};
}, token);
console.log(JSON.stringify(out));
process.exit(0); // no browser.close(): it would send Browser.close
