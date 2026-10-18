import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { variants } from "./harness";

// Prompt suggestions on a phone (touch input, Chromium device emulation on the dev harness): the best candidate
// is the first chip of ONE sideways-scrolling row above the field, never the placeholder; a tap fills the field
// without sending; a long press offers "Send now"; no key hints; no inline completion requests.
// OMP_GUI_SUGGEST_TOUCH=<dir> writes the en/ko light captures (the task's /tmp/suggest-touch/).

const captures = process.env.OMP_GUI_SUGGEST_TOUCH;

test.describe.configure({ retries: 1 });

const CANDIDATES = {
	en: ["Run the tests again", "Show me the diff", "Commit this change"],
	ko: ["테스트 다시 돌려줘", "변경 내용 보여줘", "이 변경 커밋해줘"],
} as const;

let server: ViteDevServer | undefined;
let origin = "";
let browser: Browser;

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
	browser = await chromium.launch();
});

test.afterAll(async () => {
	await browser?.close();
	await server?.close();
});

type Lang = "en" | "ko";

/** A phone with the built-in suggestions on and three candidates waiting for the idle composer. */
async function openPhone(lang: Lang, theme: "light" | "dark" = "light"): Promise<Page> {
	const context = await browser.newContext({ ...devices["Pixel 8"] });
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => window.__stores?.nextPrompt !== undefined, undefined, { timeout: 45_000 });
	await expect(page.locator("html")).toHaveAttribute("data-input", "touch");
	await page.evaluate(candidates => {
		const stores = window.__stores;
		if (!stores) throw new Error("no stores");
		const session = stores.session.getState() as { sessionFile: string | null; sessionId: string };
		stores.session.setState({
			status: "ready",
			isStreaming: false,
			nextPrompt: { suggestions: true, inline: true, legacyExtension: false, requests: { suggest: 0, inline: 0 } },
		});
		const key = session.sessionFile || session.sessionId;
		(stores.nextPrompt.getState() as { recordUpdate(key: string, update: unknown): void }).recordUpdate(key, {
			type: "next_prompt_update",
			status: "ready",
			sessionId: session.sessionId,
			candidates,
		});
	}, CANDIDATES[lang]);
	return page;
}

/** The suggestions share the status chip row's one scroller (`.omp-next-chips` is `display: contents` there). */
const row = (page: Page): Locator => page.locator("[data-status-row]");
const suggestionGroup = (page: Page): Locator => page.locator(".omp-next-chips");
const chips = (page: Page): Locator => page.locator("[data-next-chip]");
const field = (page: Page): Locator => page.locator("textarea").first();
const draft = (page: Page): Promise<string> =>
	page.evaluate(() => (window.__stores?.composer.getState() as { draft: string } | undefined)?.draft ?? "");
const unhandled = (page: Page): Promise<string[]> => page.evaluate(() => window.__harness?.unhandled ?? []);

async function capture(page: Page, name: string): Promise<void> {
	if (!captures) return;
	await fs.mkdir(captures, { recursive: true });
	await page.waitForTimeout(450);
	await page.screenshot({ path: path.join(captures, `${name}.png`), animations: "disabled" });
}

for (const lang of variants<Lang>(["en", "ko"], () => true)) {
	test.describe(`phone · ${lang}`, () => {
		test("one scrolling row of chips: the best candidate first, no placeholder copy, no key hints", async () => {
			const page = await openPhone(lang);
			try {
				await expect(chips(page)).toHaveText([...CANDIDATES[lang]]);
				await expect(field(page)).not.toHaveAttribute("placeholder", CANDIDATES[lang][0]);
				await expect(page.locator(".omp-next-chips kbd")).toHaveCount(0);
				// The row is the status chip row: 44 px, one scroller; the live chips come first, then the divider, then
				// the suggestions (the same row, so the idle chrome stays one row).
				const box = await row(page).boundingBox();
				expect(box?.height).toBe(44);
				await expect(row(page)).toHaveCSS("overflow-x", "auto");
				expect(await suggestionGroup(page).evaluate(element => getComputedStyle(element).display)).toBe("contents");
				const order = await row(page).evaluate(element =>
					Array.from(element.children).map(child =>
						child.hasAttribute("data-status-divider")
							? "divider"
							: child.classList.contains("omp-next-chips")
								? "suggestions"
								: (child.getAttribute("data-chip") ??
									child.querySelector("[data-chip]")?.getAttribute("data-chip") ??
									"?"),
					),
				);
				expect(order).toEqual(["model", "plan", "run", "context", "divider", "suggestions"]);
				// One row: every chip shares a top edge, even when they do not all fit.
				const tops = await row(page)
					.locator("[data-chip], [data-next-chip]")
					.evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)));
				expect(new Set(tops).size).toBe(1);
				const heights = await chips(page).evaluateAll(items =>
					items.map(item => item.getBoundingClientRect().height),
				);
				for (const height of heights) expect(height).toBeLessThanOrEqual(28);
				await capture(page, `${lang}-light-chips`);
			} finally {
				await page.context().close();
			}
		});

		test("a tap puts the text in the field with the caret at the end and sends nothing", async () => {
			const page = await openPhone(lang);
			try {
				await chips(page).nth(1).tap();
				await expect.poll(() => draft(page)).toBe(CANDIDATES[lang][1]);
				await expect(chips(page)).toHaveCount(0);
				await expect(row(page)).toHaveCount(0);
				const caret = await field(page).evaluate(element => (element as HTMLTextAreaElement).selectionStart);
				expect(caret).toBe(CANDIDATES[lang][1].length);
				expect(await unhandled(page)).not.toContain("rpc:prompt");
				await capture(page, `${lang}-light-filled`);
			} finally {
				await page.context().close();
			}
		});

		test("a long press offers Send now, and typing hides the row", async () => {
			const page = await openPhone(lang);
			try {
				await chips(page).nth(0).dispatchEvent("contextmenu");
				const sendNow = page.locator("[data-next-chip-send]");
				await expect(sendNow).toBeVisible();
				await capture(page, `${lang}-light-send-now`);
				// Anything else tapped dismisses it without sending.
				await page.locator("header").first().dispatchEvent("pointerdown");
				await expect(sendNow).toHaveCount(0);
				await field(page).fill("a");
				await expect(row(page)).toHaveCount(0);
			} finally {
				await page.context().close();
			}
		});

		test("typing makes no inline completion request", async () => {
			const page = await openPhone(lang);
			try {
				await field(page).click();
				await field(page).pressSequentially("please refactor the parser module", { delay: 20 });
				await page.waitForTimeout(1500);
				expect(await unhandled(page)).not.toContain("rpc:complete_inline");
				await expect(page.locator("[data-inline-ghost]")).toHaveCount(0);
			} finally {
				await page.context().close();
			}
		});
	});
}
