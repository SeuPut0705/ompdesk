import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import {
	type Browser,
	type BrowserType,
	chromium,
	devices,
	expect,
	type Locator,
	type Page,
	test,
	webkit,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { hitSizes, variants } from "./harness";

/**
 * The phone composer, end to end on the dev harness (390x844, touch input, Chromium iPhone 15 / Pixel 8 and WebKit):
 * `[+] [field] [Send | mic]` with ONE 44 px status chip row above the box (model · thinking, Plan, Run, context, then
 * the suggestions), chip sheets that move nothing, a `+` sheet that carries the run settings while the chip row is
 * hidden (keyboard up, or under 420 px visible), and a field that keeps focus through every control.
 *
 * The keyboard is emulated by shrinking the viewport to 508 px (what an iPhone leaves above a 336 px keyboard).
 * OMP_GUI_PHONE_COMPOSER=<dir> writes `phone-<state>-<engine>-<theme>-<lang>.png` captures; OMP_GUI_VARIANTS=1 runs
 * every theme and language.
 */

const captures = process.env.OMP_GUI_PHONE_COMPOSER;

test.describe.configure({ retries: 1 });

type Lang = "en" | "ko";
type Theme = "light" | "dark";

interface Engine {
	name: string;
	type: BrowserType;
	device: (typeof devices)[string];
}

const ENGINES: Engine[] = [
	{ name: "chromium", type: chromium, device: devices["iPhone 15"] },
	{ name: "pixel8", type: chromium, device: devices["Pixel 8"] },
	{ name: "webkit", type: webkit, device: devices["iPhone 15"] },
];

const CANDIDATES = {
	en: ["Run the tests again", "Show me the diff", "Commit this change"],
	ko: ["테스트 다시 돌려줘", "변경 내용 보여줘", "이 변경 커밋해줘"],
} as const;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let server: ViteDevServer | undefined;
let origin = "";
const browsers = new Map<string, Browser>();

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
	for (const browser of browsers.values()) await browser.close();
	await server?.close();
});

async function browserFor(engine: Engine): Promise<Browser> {
	const key = engine.type.name();
	let browser = browsers.get(key);
	if (!browser) {
		browser = await engine.type.launch();
		browsers.set(key, browser);
	}
	return browser;
}

interface PhoneOptions {
	lang?: Lang;
	theme?: Theme;
	width?: number;
	height?: number;
	/** Dictation on: the empty Send slot is a mic. */
	stt?: boolean;
	/** Three suggestions waiting for the idle composer. */
	suggestions?: boolean;
}

/** A phone on the harness with the composer idle. */
async function openPhone(engine: Engine, options: PhoneOptions = {}): Promise<Page> {
	const { lang = "en", theme = "light", width = 390, height = 844, stt = false, suggestions = true } = options;
	const browser = await browserFor(engine);
	const context = await browser.newContext({
		...engine.device,
		viewport: { width, height },
		screen: { width, height },
	});
	const page = await context.newPage();
	page.on("pageerror", error => {
		throw error;
	});
	await page.goto(`${origin}/harness.html?theme=${theme}&lang=${lang}`);
	await expect(page.locator("[data-titlebar-session-name]")).toBeVisible({ timeout: 45_000 });
	await page.waitForFunction(() => window.__stores?.nextPrompt !== undefined, undefined, { timeout: 45_000 });
	await expect(page.locator("html")).toHaveAttribute("data-input", "touch");
	await expect(page.locator("html")).toHaveAttribute("data-shell", "phone");
	await page.evaluate(
		({ candidates, stt: dictation, suggestions: suggest }) => {
			const stores = window.__stores;
			if (!stores) throw new Error("no stores");
			const session = stores.session.getState() as { sessionFile: string | null; sessionId: string };
			stores.session.setState({
				status: "ready",
				isStreaming: false,
				nextPrompt: {
					suggestions: true,
					inline: true,
					legacyExtension: false,
					requests: { suggest: 0, inline: 0 },
				},
			});
			stores.settings?.setState({ sttEnabled: dictation });
			if (!suggest) return;
			const key = session.sessionFile || session.sessionId;
			(stores.nextPrompt.getState() as { recordUpdate(key: string, update: unknown): void }).recordUpdate(key, {
				type: "next_prompt_update",
				status: "ready",
				sessionId: session.sessionId,
				candidates,
			});
		},
		{ candidates: [...CANDIDATES[lang]], stt, suggestions },
	);
	await expect(page.locator(".omp-composer-box")).toBeVisible();
	return page;
}

const field = (page: Page): Locator => page.locator("textarea[data-composer-input]").first();
const statusRow = (page: Page): Locator => page.locator("[data-status-row]");
const chip = (page: Page, name: string): Locator => page.locator(`[data-status-row] [data-chip="${name}"]`);
const plus = (page: Page): Locator => page.locator(".omp-composer-toolbar [aria-haspopup='menu']").first();
const sendSlot = (page: Page): Locator => page.locator("[data-slot='send']");
const unhandled = (page: Page): Promise<string[]> => page.evaluate(() => window.__harness?.unhandled ?? []);
/** Whether the page asked the host for this rpc command (the harness records every call, handled or not). */
const called = (page: Page, command: string): Promise<boolean> =>
	page.evaluate(
		type =>
			(window.__harness?.calls ?? []).some(call =>
				JSON.stringify(call.args[0] ?? null).includes(`"type":"${type}"`),
			),
		command,
	);
const focusedIsField = (page: Page): Promise<boolean> =>
	page.evaluate(() => document.activeElement?.matches("textarea[data-composer-input]") === true);

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

async function boxOf(locator: Locator): Promise<Box> {
	const box = await locator.first().boundingBox();
	if (!box) throw new Error("no box");
	return box;
}

/** The chrome around the transcript: what the header, work strip, status row and composer take of the screen. */
async function chromePx(page: Page): Promise<{ transcript: number; chrome: number; share: number; visible: number }> {
	const visible = page.viewportSize()?.height ?? 0;
	const transcript = (await boxOf(page.locator(".omp-transcript-editorial"))).height;
	return { transcript, chrome: visible - transcript, share: (visible - transcript) / visible, visible };
}

async function layout(page: Page): Promise<Record<string, Box | null>> {
	const names: Record<string, Locator> = {
		header: page.locator(".omp-titlebar").first(),
		transcript: page.locator(".omp-transcript-editorial"),
		box: page.locator(".omp-composer-box"),
		field: field(page),
		send: sendSlot(page),
	};
	const out: Record<string, Box | null> = {};
	for (const [name, locator] of Object.entries(names)) out[name] = await locator.first().boundingBox();
	return out;
}

function expectSameLayout(before: Record<string, Box | null>, after: Record<string, Box | null>, what: string): void {
	for (const key of Object.keys(before)) expect(after[key], `${what}: ${key}`).toEqual(before[key]);
}

async function capture(
	page: Page,
	state: string,
	engine: Engine,
	theme: Theme = "light",
	lang: Lang = "en",
): Promise<void> {
	if (!captures) return;
	await fs.mkdir(captures, { recursive: true });
	await page.waitForTimeout(450);
	await page.screenshot({
		path: path.join(captures, `phone-${state}-${engine.name}-${theme}-${lang}.png`),
		animations: "disabled",
	});
}

/** Emulate the soft keyboard: the field is focused and the visible height shrinks (iPhone 15: 844 → 508). */
async function keyboardUp(page: Page, visible = 508): Promise<void> {
	const width = page.viewportSize()?.width ?? 390;
	await field(page).focus();
	await page.setViewportSize({ width, height: visible });
	await expect(page.locator("html")).toHaveAttribute("data-kb", "open", { timeout: 5_000 });
}

async function keyboardDown(page: Page, full = 844): Promise<void> {
	const width = page.viewportSize()?.width ?? 390;
	await page.setViewportSize({ width, height: full });
	await expect(page.locator("html")).not.toHaveAttribute("data-kb", "open", { timeout: 5_000 });
}

async function setRunning(page: Page, running: boolean): Promise<void> {
	await page.evaluate(value => window.__stores?.session.setState({ isStreaming: value }), running);
}

async function attach(page: Page, count: number): Promise<void> {
	await page.evaluate(
		({ n, png }) => {
			const images = Array.from({ length: n }, (_, index) => ({
				content: { type: "image", data: png, mimeType: "image/png", id: `i${index}` },
				preview: `data:image/png;base64,${png}`,
			}));
			window.__stores?.composer.setState({ images });
		},
		{ n: count, png: PNG },
	);
}

/** Share of the control's drawn box (a 6x6 grid) that `elementFromPoint` resolves to the control itself. */
async function ownShare(locator: Locator): Promise<number> {
	return locator.first().evaluate(node => {
		const box = node.getBoundingClientRect();
		let own = 0;
		let total = 0;
		for (let row = 0; row < 6; row++) {
			for (let column = 0; column < 6; column++) {
				const x = box.left + ((column + 0.5) / 6) * box.width;
				const y = box.top + ((row + 0.5) / 6) * box.height;
				const hit = document.elementFromPoint(x, y);
				total++;
				if (hit && (hit === node || node.contains(hit))) own++;
			}
		}
		return own / total;
	});
}

for (const engine of ENGINES) {
	for (const lang of variants<Lang>(["en", "ko"])) {
		for (const theme of variants<Theme>(["light", "dark"])) {
			const tag = `${engine.name} · ${theme} · ${lang}`;
			test.describe(`phone composer · ${tag}`, () => {
				test("is one row [+] [field] [Send] under a 44 px status chip row, and the idle chrome stays at or under 22 %", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						const row = await boxOf(statusRow(page));
						expect(row.height).toBe(44);
						await expect(statusRow(page)).toHaveAttribute("role", "toolbar");
						// Live state first, then the suggestions after a divider, in one scroller.
						const order = await statusRow(page).evaluate(element =>
							Array.from(element.children).map(child =>
								child.hasAttribute("data-status-divider")
									? "divider"
									: child.classList.contains("omp-next-chips")
										? "suggestions"
										: (child.getAttribute("data-chip") ??
											child.querySelector("[data-chip]")?.getAttribute("data-chip")),
							),
						);
						expect(order).toEqual(["model", "plan", "run", "context", "divider", "suggestions"]);
						// The box is ONE row: + · field · Send share a line and there is no ⋯ anywhere.
						const box = await boxOf(page.locator(".omp-composer-box"));
						expect(box.height).toBeLessThanOrEqual(56);
						await expect(page.locator(".omp-composer-more")).toHaveCount(0);
						await expect(page.getByRole("button", { name: /Mode, model and more|모드, 모델 등/ })).toHaveCount(0);
						const plusBox = await boxOf(plus(page));
						const sendBox = await boxOf(sendSlot(page).locator("button").first());
						const fieldBox = await boxOf(field(page));
						expect(plusBox.x + plusBox.width).toBeLessThanOrEqual(fieldBox.x + 2);
						expect(sendBox.x).toBeGreaterThanOrEqual(fieldBox.x + fieldBox.width - 2);
						expect(fieldBox.width).toBeGreaterThanOrEqual(260);
						const { share, chrome } = await chromePx(page);
						expect(share, `chrome ${chrome}px`).toBeLessThanOrEqual(0.22);
						// The row, the box and the work strip never overflow the page sideways.
						expect(
							await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
						).toBeLessThanOrEqual(0);
						await capture(page, "idle", engine, theme, lang);
						await statusRow(page).evaluate(element => {
							element.scrollLeft = element.scrollWidth;
						});
						await capture(page, "chips", engine, theme, lang);
					} finally {
						await page.context().close();
					}
				});

				test("opens a sheet per chip without moving anything, and returns focus to the field", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await field(page).focus();
						const before = await layout(page);
						// Run: Tool approval + Delegation as 44 px rows in a bottom sheet.
						await chip(page, "run").tap();
						const sheet = page.locator("[data-composer-sheet]");
						await expect(sheet).toBeVisible();
						expectSameLayout(before, await layout(page), "run sheet open");
						for (const row of await page.locator("[data-approval-option], [data-delegation-option]").all()) {
							expect((await boxOf(row)).height).toBeGreaterThanOrEqual(43.5);
						}
						expect(await focusedIsField(page)).toBe(true);
						await capture(page, "sheet-run", engine, theme, lang);
						await page.keyboard.press("Escape");
						await expect(sheet).toHaveCount(0);
						expectSameLayout(before, await layout(page), "run sheet closed");
						expect(await focusedIsField(page)).toBe(true);
						// Context: the breakdown is a sheet too, never a floating card.
						await chip(page, "context").tap();
						await expect(sheet).toBeVisible();
						expectSameLayout(before, await layout(page), "context sheet open");
						for (const button of await sheet.locator("button").all()) {
							expect((await boxOf(button)).height).toBeGreaterThanOrEqual(43.5);
						}
						await capture(page, "sheet-context", engine, theme, lang);
						await page.keyboard.press("Escape");
						await expect(sheet).toHaveCount(0);
						expectSameLayout(before, await layout(page), "context sheet closed");
						// The + sheet.
						await plus(page).tap();
						await expect(page.locator("[data-action-sheet]")).toBeVisible();
						expectSameLayout(before, await layout(page), "+ sheet open");
						await capture(page, "sheet-plus", engine, theme, lang);
						await page.keyboard.press("Escape");
						await expect(page.locator("[data-action-sheet]")).toHaveCount(0);
						expectSameLayout(before, await layout(page), "+ sheet closed");
						expect(await focusedIsField(page)).toBe(true);
						// The model picker (the existing dialog sheet).
						await chip(page, "model").tap();
						await expect(page.getByRole("dialog")).toBeVisible();
						await capture(page, "sheet-model", engine, theme, lang);
						await page.keyboard.press("Escape");
						await expect(page.getByRole("dialog")).toHaveCount(0);
						expectSameLayout(before, await layout(page), "model picker closed");
					} finally {
						await page.context().close();
					}
				});

				test("takes the number of taps the design promises (model 2, thinking 2, plan 1, approval 2, delegation 2, mic 1)", async () => {
					const page = await openPhone(engine, { lang, theme, stt: true });
					try {
						// Plan: ONE tap on the chip asks the agent to switch plan mode on.
						await chip(page, "plan").tap();
						await expect.poll(() => unhandled(page)).toContain("rpc:set_plan_mode");
						// Model: the chip, then a model row.
						await chip(page, "model").tap();
						const dialog = page.getByRole("dialog");
						await expect(dialog).toBeVisible();
						const options = dialog.locator("[data-model-option]");
						await expect(options.first()).toBeVisible({ timeout: 15_000 });
						await options.last().tap();
						await expect.poll(() => unhandled(page)).toContain("rpc:set_model");
						await expect(dialog).toHaveCount(0);
						// Thinking: the chip, then a level in the picker's effort row.
						await chip(page, "model").tap();
						await expect(dialog).toBeVisible();
						const effort = dialog.locator("[data-thinking-option]").first();
						if (await effort.count()) {
							await effort.tap();
							await expect.poll(() => unhandled(page)).toContain("rpc:set_thinking_level");
						}
						await page.keyboard.press("Escape");
						await expect(dialog).toHaveCount(0);
						// Approval: the Run chip, then a row (a stricter one applies at once).
						await chip(page, "run").tap();
						await page.locator("[data-approval-option='always-ask']").tap();
						await expect.poll(() => unhandled(page)).toContain("rpc:set_setting");
						// Delegation: the Run chip again, then one tap on a strength.
						await page.keyboard.press("Escape");
						await chip(page, "run").tap();
						await page.locator("[data-delegation-option='solo']").tap();
						await expect.poll(() => called(page, "set_delegation")).toBe(true);
						await page.keyboard.press("Escape");
						// Mic: the empty Send slot is the mic (one tap starts dictation).
						const mic = sendSlot(page).locator(".omp-composer-mic");
						await expect(mic).toHaveCount(1);
						await expect(mic).toBeVisible();
						await capture(page, "mic", engine, theme, lang);
						await field(page).fill("hello");
						await expect(sendSlot(page).locator(".omp-composer-mic")).toHaveCount(0);
						await expect(sendSlot(page).locator("button:not([disabled])")).toHaveCount(1);
					} finally {
						await page.context().close();
					}
				});

				test("keeps the field focused through +, every chip, Send, Stop, the lane chip and the mic", async () => {
					const page = await openPhone(engine, { lang, theme, stt: true });
					try {
						await field(page).focus();
						for (const name of ["plan", "run", "context"]) {
							await chip(page, name).tap();
							expect(await focusedIsField(page), `chip ${name}`).toBe(true);
							await page.keyboard.press("Escape");
							await page.waitForTimeout(150);
							expect(await focusedIsField(page), `chip ${name} closed`).toBe(true);
						}
						// The model picker has a search field of its own: it takes focus while open and hands it back.
						await chip(page, "model").tap();
						await expect(page.getByRole("dialog")).toBeVisible();
						await page.keyboard.press("Escape");
						await expect(page.getByRole("dialog")).toHaveCount(0);
						await expect.poll(() => focusedIsField(page), { message: "model picker closed" }).toBe(true);
						await plus(page).tap();
						expect(await focusedIsField(page)).toBe(true);
						await page.keyboard.press("Escape");
						expect(await focusedIsField(page)).toBe(true);
						// The mic in the empty Send slot.
						await sendSlot(page).locator(".omp-composer-mic").tap();
						expect(await focusedIsField(page), "mic").toBe(true);
						// A running turn with a draft: lane chip, Stop and Send.
						await setRunning(page, true);
						await field(page).focus();
						await field(page).fill("and also lint it");
						await page.locator("[data-send-mode]").tap();
						expect(await focusedIsField(page), "lane chip").toBe(true);
						await page.locator("[data-slot='stop'] button").tap();
						expect(await focusedIsField(page), "stop").toBe(true);
						await sendSlot(page).locator("button:not([disabled])").tap();
						expect(await focusedIsField(page), "send").toBe(true);
					} finally {
						await page.context().close();
					}
				});

				test("hides the chip row while the keyboard is up and the + sheet carries Model / Mode / Tool approval / Delegation", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await keyboardUp(page);
						await expect(statusRow(page)).toHaveCount(0);
						const { transcript, visible } = await chromePx(page);
						expect(visible).toBe(508);
						// Header + work strip + one-row box: the transcript keeps most of the 508 px.
						expect(transcript, "keyboard-up transcript px").toBeGreaterThanOrEqual(360);
						await capture(page, "keyboard-up", engine, theme, lang);
						await plus(page).tap();
						const rows = page.locator("[data-action-sheet] [data-menu-item]");
						await expect(rows.filter({ hasText: /Change model|모델 변경/ })).toHaveCount(1);
						await expect(rows.filter({ hasText: /^Mode|^모드/ })).toHaveCount(1);
						await expect(rows.filter({ hasText: /Tool approval|도구 승인/ })).toHaveCount(1);
						await expect(rows.filter({ hasText: /Delegation|위임/ })).toHaveCount(1);
						expect(await focusedIsField(page)).toBe(true);
						await capture(page, "keyboard-up-plus", engine, theme, lang);
						// Tool approval is three taps: +, the row, an option; the field keeps focus all the way.
						await rows.filter({ hasText: /Tool approval|도구 승인/ }).tap();
						await expect(page.locator("[data-approval-option]").first()).toBeVisible();
						expect(await focusedIsField(page)).toBe(true);
						await page.locator("[data-approval-option='always-ask']").tap();
						await expect.poll(() => unhandled(page)).toContain("rpc:set_setting");
						expect(await focusedIsField(page)).toBe(true);
						await page.keyboard.press("Escape");
						await keyboardDown(page);
						await expect(statusRow(page)).toBeVisible();
						await field(page).fill("Please run the tests again, then show me the diff and commit it");
						await keyboardUp(page);
						await capture(page, "keyboard-up-typing", engine, theme, lang);
						expect((await chromePx(page)).transcript).toBeGreaterThanOrEqual(340);
						await field(page).fill("one\ntwo\nthree");
						await capture(page, "keyboard-up-multiline", engine, theme, lang);
						// The field never takes more than 40 % of the pane and leaves 120 px of the visible screen.
						const fieldBox = await boxOf(field(page));
						expect(fieldBox.height).toBeLessThanOrEqual(508 - 120);
					} finally {
						await page.context().close();
					}
				});

				test("drops the chip row under 420 px of visible height (landscape) and keeps every setting reachable", async () => {
					const page = await openPhone(engine, { lang, theme, width: 844, height: 390 });
					try {
						await expect(statusRow(page)).toHaveCount(0);
						await capture(page, "landscape-idle", engine, theme, lang);
						await plus(page).tap();
						await expect(
							page.locator("[data-action-sheet] [data-menu-item]").filter({ hasText: /Delegation|위임/ }),
						).toHaveCount(1);
						await page.keyboard.press("Escape");
						await keyboardUp(page, 190);
						await capture(page, "landscape-keyboard", engine, theme, lang);
						const box = await boxOf(page.locator(".omp-composer-box"));
						expect(box.y + box.height).toBeLessThanOrEqual(190 + 1);
					} finally {
						await page.context().close();
					}
				});

				test("shows the lane as a text chip beside Stop and Send while a turn runs, with the field at 140 px or more", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await setRunning(page, true);
						await expect(page.locator("[data-send-mode]")).toBeVisible();
						expect((await page.locator("[data-send-mode]").innerText()).trim().length).toBeGreaterThan(0);
						await capture(page, "running", engine, theme, lang);
						await field(page).fill("and also lint it");
						const fieldBox = await boxOf(field(page));
						expect(fieldBox.width).toBeGreaterThanOrEqual(140);
						await capture(page, "running-draft", engine, theme, lang);
						// The turn starting or ending moves nothing in the box.
						await field(page).fill("");
						const running = await layout(page);
						await setRunning(page, false);
						const idle = await layout(page);
						expect(idle.field?.x).toBe(running.field?.x);
						expect(idle.send).toEqual(running.send);
						expect(idle.box?.y).toBe(running.box?.y);
						await setRunning(page, true);
						// Queued messages: the pill carries the count, the lane chip steps aside, the field keeps 140 px.
						await page.evaluate(() => {
							window.__stores?.session.setState({ queuedMessageCount: 2 });
							window.__stores?.queue.setState({
								steering: [{ id: "q1", text: "Then update the changelog" }],
								followUp: [{ id: "q2", text: "Run the whole e2e suite afterwards" }],
							});
						});
						await field(page).fill("one more thing");
						await expect(page.locator("[data-queue-pill]")).toBeVisible();
						await expect(page.locator("[data-send-mode]")).toBeHidden();
						expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(140);
						await capture(page, "queue", engine, theme, lang);
					} finally {
						await page.context().close();
					}
				});

				test("reaches every control with a finger: 44 px where nothing is adjacent, no tap stolen from the row", async () => {
					const page = await openPhone(engine, { lang, theme, stt: true });
					try {
						const reach = async (locator: Locator, label: string, min: number) => {
							for (const size of await hitSizes(locator)) {
								expect(size.hit.width, `${label} ${size.label} width`).toBeGreaterThanOrEqual(min);
								expect(size.hit.height, `${label} ${size.label} height`).toBeGreaterThanOrEqual(min);
							}
						};
						await reach(plus(page), "+", 44);
						await reach(sendSlot(page).locator("button"), "Send/mic", 44);
						await reach(page.locator("[data-status-row] [data-chip]"), "status chips", 42);
						// Drawn sizes stay dense: 28 px chips, 28 px buttons.
						for (const size of await hitSizes(page.locator("[data-status-row] [data-chip]"))) {
							expect(size.visual.height).toBeLessThanOrEqual(28.5);
						}
						for (const size of await hitSizes(plus(page))) expect(size.visual.width).toBeLessThanOrEqual(28.5);
						for (const locator of [
							plus(page),
							sendSlot(page).locator("button").first(),
							chip(page, "model"),
							chip(page, "plan"),
						]) {
							expect(await ownShare(locator)).toBe(1);
						}
						await setRunning(page, true);
						await field(page).fill("and also lint it");
						for (const [locator, label] of [
							[page.locator("[data-slot='stop'] button"), "Stop"],
							[page.locator("[data-send-mode]"), "lane chip"],
							[sendSlot(page).locator("button").first(), "Send"],
						] as const) {
							await reach(locator, label, label === "lane chip" ? 42 : 44);
							expect(await ownShare(locator), label).toBe(1);
						}
					} finally {
						await page.context().close();
					}
				});

				test("holds twenty pictures in one scrolling row (a box of 150 px or less) and types at 40 ms or less on a 4x slower CPU", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await attach(page, 20);
						await expect(page.locator(".omp-attach-strip")).toBeVisible();
						const box = await boxOf(page.locator(".omp-composer-box"));
						expect(box.height, "20 pictures").toBeLessThanOrEqual(150);
						await capture(page, "attachments", engine, theme, lang);
						if (engine.type === chromium) {
							const cdp = await page.context().newCDPSession(page);
							await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
							await field(page).focus();
							const samples = await page.evaluate(async () => {
								const element = document.querySelector("textarea[data-composer-input]") as HTMLTextAreaElement;
								const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
								const times: number[] = [];
								for (let index = 0; index < 40; index++) {
									const start = performance.now();
									setter?.call(element, `${element.value}a`);
									element.dispatchEvent(
										new InputEvent("input", { bubbles: true, inputType: "insertText", data: "a" }),
									);
									void element.offsetHeight;
									times.push(performance.now() - start);
									const { promise, resolve } = Promise.withResolvers<void>();
									setTimeout(resolve, 8);
									await promise;
								}
								return times;
							});
							await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
							const sorted = [...samples].sort((a, b) => a - b);
							const median = sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
							console.log(`keystroke p50 ${engine.name}: ${median.toFixed(1)} ms (20 pictures, 4x CPU)`);
							expect(median).toBeLessThanOrEqual(40);
						}
					} finally {
						await page.context().close();
					}
				});

				test("fills the screen with a column when expanded (head, field, footer with +/Send) and has no $EDITOR button", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await plus(page).tap();
						await page
							.locator("[data-action-sheet] [data-menu-item]")
							.filter({ hasText: /Expand|확대|펼치|확장/ })
							.first()
							.tap();
						const region = page.locator(".omp-composer-region--expanded");
						await expect(region).toBeVisible();
						await expect(statusRow(page)).toHaveCount(0);
						const box = await boxOf(page.locator(".omp-composer-region--expanded .omp-composer-box"));
						expect(box.height).toBeGreaterThan(500);
						const fieldBox = await boxOf(field(page));
						const sendBox = await boxOf(sendSlot(page).locator("button").first());
						const plusBox = await boxOf(plus(page));
						expect(fieldBox.height).toBeGreaterThan(300);
						// The footer row sits under the field: + at the left, Send at the right.
						expect(plusBox.y).toBeGreaterThan(fieldBox.y + fieldBox.height - 2);
						expect(sendBox.y).toBeGreaterThan(fieldBox.y + fieldBox.height - 2);
						expect(plusBox.x).toBeLessThan(sendBox.x);
						expect(sendBox.x + sendBox.width).toBeGreaterThan(box.x + box.width - 30);
						await expect(page.getByRole("button", { name: /external editor|외부 편집기/i })).toHaveCount(0);
						await capture(page, "expanded", engine, theme, lang);
					} finally {
						await page.context().close();
					}
				});

				test("sizes the slash menu from the room above the composer and gives its rows 44 px", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await field(page).focus();
						await field(page).fill("/");
						const menu = page.locator("[data-completion-menu]");
						await expect(menu).toBeVisible({ timeout: 15_000 });
						for (const option of await menu.locator("[role='option']").all()) {
							expect((await boxOf(option)).height).toBeGreaterThanOrEqual(43.5);
						}
						await expect(menu.locator("kbd")).toHaveCount(0);
						const header = await boxOf(page.locator(".omp-titlebar").first());
						const top = (await boxOf(menu)).y;
						expect(top).toBeGreaterThanOrEqual(header.y + header.height - 1);
						await capture(page, "slash-menu", engine, theme, lang);
						await keyboardUp(page, 330);
						const small = await boxOf(menu);
						expect(small.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
						expect(small.y + small.height).toBeLessThanOrEqual(330);
					} finally {
						await page.context().close();
					}
				});

				test("shows typing and multiline drafts in the one row, growing only upwards", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						const before = await boxOf(page.locator(".omp-composer-box"));
						await field(page).fill("Please run the tests again");
						await capture(page, "typing", engine, theme, lang);
						const typed = await boxOf(page.locator(".omp-composer-box"));
						expect(typed.y + typed.height).toBeCloseTo(before.y + before.height, 0);
						await field(page).fill("first line\nsecond line\nthird line");
						await capture(page, "multiline", engine, theme, lang);
						const multi = await boxOf(page.locator(".omp-composer-box"));
						expect(multi.y + multi.height).toBeCloseTo(before.y + before.height, 0);
						expect(multi.height).toBeGreaterThan(typed.height);
						// The suggestions step out of sight while a draft is typed, and the row keeps its 44 px.
						expect((await boxOf(statusRow(page))).height).toBe(44);
					} finally {
						await page.context().close();
					}
				});
			});
		}
	}

	test.describe(`phone composer sizes · ${engine.name}`, () => {
		for (const [width, height] of [
			[360, 780],
			[430, 932],
		] as const) {
			test(`${width}x${height}: one row, the chips scroll, nothing overflows`, async () => {
				const page = await openPhone(engine, { width, height });
				try {
					expect((await boxOf(statusRow(page))).height).toBe(44);
					const box = await boxOf(page.locator(".omp-composer-box"));
					expect(box.x + box.width).toBeLessThanOrEqual(width);
					expect(
						await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
					).toBeLessThanOrEqual(0);
					expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(width - 130);
					await capture(page, `idle-${width}`, engine);
					await setRunning(page, true);
					await field(page).fill("and also lint it");
					expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(140);
					await capture(page, `running-draft-${width}`, engine);
				} finally {
					await page.context().close();
				}
			});
		}
	});
}
