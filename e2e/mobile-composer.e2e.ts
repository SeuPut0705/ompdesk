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
 * one always-open box (a full-width field row, then one row of every control inside the box: +, the Run chip, the
 * model chip, the context ring, Stop/Send | mic), no row above it but the prompt suggestions, settings that move nothing,
 * Korean that wraps only at the box's inner width, and a field that keeps focus through every control.
 *
 * The keyboard is emulated by shrinking the viewport to 508 px (what an iPhone leaves above a 336 px keyboard).
 * OMP_GUI_PHONE_COMPOSER=<dir> writes `phone-<state>-<engine>-<theme>-<lang>.png` captures; OMP_GUI_VARIANTS=1 runs
 * every theme and language.
 */

const captures = process.env.OMP_GUI_PHONE_COMPOSER;
/** The idle chrome (header, work strip, composer) at 390x844 without suggestions: measured, plus one point. */
const PHONE_CHROME_MAX = 0.194;

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
	// Twice on hosted runners (Chromium, iPhone 15) the page kept `mouse` for 10 s; never seen locally in 500+ loads.
	// Name what the browser said then, so the next one tells an emulation glitch from a missed media change.
	await expect(page.locator("html"))
		.toHaveAttribute("data-input", "touch")
		.catch(async (error: Error) => {
			const media = await page.evaluate(() => ({
				coarse: matchMedia("(pointer: coarse)").matches,
				anyCoarse: matchMedia("(any-pointer: coarse)").matches,
				hoverNone: matchMedia("(hover: none)").matches,
				maxTouchPoints: navigator.maxTouchPoints,
			}));
			throw new Error(`${error.message}\nthe browser now says ${JSON.stringify(media)}`);
		});
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
const runChip = (page: Page): Locator => page.locator(".omp-composer-box [data-run-settings-trigger]");
const modelChip = (page: Page): Locator => page.locator(".omp-composer-box [data-model-chip]");
const contextRing = (page: Page): Locator => page.locator(".omp-composer-box .omp-context-usage-trigger");
/** The Run chip, then its settings (mode, approval, delegation) are up. */
async function openRun(page: Page): Promise<void> {
	await runChip(page).tap();
	await expect(page.locator("[data-approval-option]").first()).toBeVisible();
}
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

/** The chrome around the transcript: what the header, work strip and composer take of the screen. */
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
				test("is one always-open box (the full-width field, then every control in one row) with nothing above it but the suggestions", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						// Every composer control is inside the box: no status row, no ⋯ fold toggle.
						await expect(page.locator("[data-run-more]")).toHaveCount(0);
						await expect(page.locator("[data-status-row]")).toHaveCount(0);
						const box = await boxOf(page.locator(".omp-composer-box"));
						console.log(`phone composer box ${box.height}px`);
						expect(box.height).toBeLessThanOrEqual(90);
						const plusBox = await boxOf(plus(page));
						const moreBox = await boxOf(runChip(page));
						const modelBox = await boxOf(modelChip(page));
						const contextBox = await boxOf(contextRing(page));
						// Thinking and Delegation live in the Run sheet: no icon of their own in the row.
						await expect(page.locator(".omp-composer-box :is(.lucide-brain, .lucide-network)")).toHaveCount(0);
						const sendBox = await boxOf(sendSlot(page).locator("button").first());
						const fieldBox = await boxOf(field(page));
						// Always open: the field is a full-width row, the controls one row under it.
						expect(fieldBox.width).toBeGreaterThanOrEqual(box.width - 30);
						for (const control of [plusBox, moreBox, modelBox, contextBox, sendBox]) {
							expect(control.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 2);
							expect(control.y + control.height).toBeLessThanOrEqual(box.y + box.height);
						}
						expect(plusBox.x).toBeLessThan(moreBox.x);
						expect(sendBox.x).toBeGreaterThanOrEqual(moreBox.x + moreBox.width - 2);
						// The suggestions are one row of their own above the box (they hide while typing).
						const chips = await boxOf(page.locator(".omp-next-chips"));
						expect(chips.y + chips.height).toBeLessThanOrEqual(box.y + 1);
						const withChips = await chromePx(page);
						console.log(
							`chrome with suggestions ${engine.name} ${lang}: ${(withChips.share * 100).toFixed(1)} %`,
						);
						expect(
							await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
						).toBeLessThanOrEqual(0);
						await capture(page, "chips", engine, theme, lang);
					} finally {
						await page.context().close();
					}
					const idle = await openPhone(engine, { lang, theme, suggestions: false });
					try {
						const { share, chrome } = await chromePx(idle);
						console.log(`idle chrome ${engine.name} ${lang}: ${(share * 100).toFixed(1)} % (${chrome}px)`);
						expect(share, `chrome ${chrome}px`).toBeLessThanOrEqual(PHONE_CHROME_MAX);
						await capture(idle, "idle", engine, theme, lang);
					} finally {
						await idle.context().close();
					}
				});

				test("wraps a long Korean line only at the box's inner width", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						const sentence = "그리고 변경사항같은거 자동으로 열리는건 별로야";
						await field(page).fill(sentence);
						const metrics = await field(page).evaluate((element, text) => {
							const area = element as HTMLTextAreaElement;
							const style = getComputedStyle(area);
							const line = Number.parseFloat(style.lineHeight);
							const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
							const wrapper = area.parentElement as HTMLElement;
							const ruler = document.createElement("canvas").getContext("2d");
							if (!ruler) throw new Error("no canvas to measure the sentence with");
							ruler.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
							return {
								client: area.clientWidth,
								wrapper: wrapper.clientWidth,
								lines: Math.round((area.scrollHeight - padding) / line),
								drawn: ruler.measureText(text).width,
							};
						}, sentence);
						expect(metrics.client, "field spans its cell").toBeGreaterThanOrEqual(metrics.wrapper - 26);
						// How wide a Korean syllable is depends on the face the machine draws it with: Malgun Gothic (Windows) sets
						// it a full em, so this sentence is 354 px against the 340 px field at 390. One line exactly when the
						// sentence is no wider than the field, so it wraps there and never sooner.
						expect(
							metrics.lines === 1,
							`a ${metrics.drawn} px sentence in a ${metrics.client} px field drew ${metrics.lines} lines`,
						).toBe(metrics.drawn <= metrics.client);
						await field(page).fill(`${sentence} ${sentence} ${sentence}`);
						expect(await field(page).evaluate(element => element.clientWidth)).toBe(metrics.client);
						await capture(page, "korean-wrap", engine, theme, lang);
					} finally {
						await page.context().close();
					}
				});

				test("opens the Run settings and the context breakdown without moving anything, and the context ring returns focus to the field", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await field(page).focus();
						const before = await layout(page);
						await openRun(page);
						expectSameLayout(before, await layout(page), "run settings open");
						// One line per row: each segmented row (thinking, approval, delegation) is a 44 px target.
						for (const row of await page.locator("[data-choice-row]").all()) {
							expect((await boxOf(row)).height).toBeGreaterThanOrEqual(43.5);
						}
						await capture(page, "sheet-run", engine, theme, lang);
						await page.keyboard.press("Escape");
						await expect(page.locator("[data-approval-option]")).toHaveCount(0);
						expectSameLayout(before, await layout(page), "run settings closed");
						await field(page).focus();
						await contextRing(page).tap();
						await expect(page.locator("[data-composer-sheet]")).toBeVisible();
						await capture(page, "sheet-context", engine, theme, lang);
						await page.keyboard.press("Escape");
						await expect(page.locator("[data-composer-sheet]")).toHaveCount(0);
						expectSameLayout(before, await layout(page), "context closed");
						expect(await focusedIsField(page)).toBe(true);
						await plus(page).tap();
						await expect(page.locator("[data-action-sheet]")).toBeVisible();
						expectSameLayout(before, await layout(page), "+ sheet open");
						await capture(page, "sheet-plus", engine, theme, lang);
						await page.keyboard.press("Escape");
						await expect(page.locator("[data-action-sheet]")).toHaveCount(0);
					} finally {
						await page.context().close();
					}
				});

				test("takes the number of taps the design promises (plan 2, approval 2, delegation 2, model 2, mic 1)", async () => {
					const page = await openPhone(engine, { lang, theme, stt: true });
					try {
						// Plan: the Run chip, then the Plan switch.
						await openRun(page);
						await page.locator("[data-plan-mode]").first().tap();
						await expect.poll(() => unhandled(page)).toContain("rpc:set_plan_mode");
						await page.keyboard.press("Escape");
						// Model: the model chip, then a model.
						await modelChip(page).tap();
						const dialog = page.getByRole("dialog");
						await expect(dialog).toBeVisible();
						const options = dialog.locator("[data-model-option]");
						await expect(options.first()).toBeVisible({ timeout: 15_000 });
						await options.last().tap();
						await expect.poll(() => unhandled(page)).toContain("rpc:set_model");
						await expect(dialog).toHaveCount(0);
						// Approval: the Run chip, then a row (a stricter one applies at once).
						await openRun(page);
						await page.locator("[data-approval-option='always-ask']").tap();
						await expect.poll(() => unhandled(page)).toContain("rpc:set_setting");
						await page.keyboard.press("Escape");
						// Delegation: the Run chip, then one tap on a strength.
						await openRun(page);
						await page.locator("[data-delegation-option='solo']").tap();
						await expect.poll(() => called(page, "set_delegation")).toBe(true);
						await page.keyboard.press("Escape");
						// Mic: the empty Send slot is the mic (one tap starts dictation).
						const mic = sendSlot(page).locator(".omp-composer-mic");
						await expect(mic).toBeVisible();
						await field(page).fill("hello");
						await expect(sendSlot(page).locator(".omp-composer-mic")).toHaveCount(0);
						await expect(sendSlot(page).locator("button:not([disabled])")).toHaveCount(1);
					} finally {
						await page.context().close();
					}
				});

				test("names a mode on the Run chip inside the box, never in a row of its own", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						const before = await boxOf(page.locator(".omp-composer-box"));
						await page.evaluate(() => window.__stores?.session.setState({ planModeEnabled: true }));
						await expect(runChip(page)).toHaveAttribute("data-active", "");
						const after = await boxOf(page.locator(".omp-composer-box"));
						expect(after.height).toBe(before.height);
						expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(330);
						await capture(page, "mode-on", engine, theme, lang);
					} finally {
						await page.context().close();
					}
				});

				test("keeps the field focused through +, the Run chip, Send, Stop, the lane chip and the mic; a long press on Send stops and keeps the draft", async () => {
					const page = await openPhone(engine, { lang, theme, stt: true });
					try {
						await field(page).focus();
						await contextRing(page).tap();
						expect(await focusedIsField(page), "context ring").toBe(true);
						await page.keyboard.press("Escape");
						await page.waitForTimeout(150);
						expect(await focusedIsField(page), "context closed").toBe(true);
						await plus(page).tap();
						expect(await focusedIsField(page)).toBe(true);
						await page.keyboard.press("Escape");
						expect(await focusedIsField(page)).toBe(true);
						await sendSlot(page).locator(".omp-composer-mic").tap();
						expect(await focusedIsField(page), "mic").toBe(true);
						await setRunning(page, true);
						await field(page).focus();
						await field(page).fill("and also lint it");
						await page.locator("[data-send-mode]").tap();
						expect(await focusedIsField(page), "lane chip").toBe(true);
						// Touch has no Esc: a long press on Send (lib/long-press-menu.ts turns a still finger into
						// `contextmenu`) opens a sheet whose Stop ends the turn and leaves the draft in the field.
						const button = sendSlot(page).getByRole("button");
						await expect(button).toHaveAttribute("data-send-state", "send");
						await expect(button.locator("[data-send-stop-hint]")).toHaveCount(1);
						await button.evaluate(element => {
							const box = element.getBoundingClientRect();
							element.dispatchEvent(
								new PointerEvent("pointerdown", {
									bubbles: true,
									clientX: box.left + box.width / 2,
									clientY: box.top + box.height / 2,
									isPrimary: true,
									pointerId: 11,
									pointerType: "touch",
								}),
							);
						});
						const stop = page.locator("[data-action-sheet] [data-menu-item]");
						await expect(stop).toHaveCount(1);
						await button.evaluate(element =>
							element.dispatchEvent(
								new PointerEvent("pointerup", {
									bubbles: true,
									isPrimary: true,
									pointerId: 11,
									pointerType: "touch",
								}),
							),
						);
						await capture(page, "running-long-press", engine, theme, lang);
						await stop.tap();
						await expect(stop).toHaveCount(0);
						await expect.poll(() => called(page, "abort_and_restore_queue")).toBe(true);
						await expect(field(page)).toHaveValue("and also lint it");
						expect(await focusedIsField(page), "stop").toBe(true);
						await sendSlot(page).locator("button:not([disabled])").tap();
						expect(await focusedIsField(page), "send").toBe(true);
						// An empty draft while the turn runs: the button is Stop, one tap. (The harness has no omp to end
						// the first Stop's turn: a fresh run clears its "stopping".)
						await setRunning(page, false);
						await setRunning(page, true);
						await field(page).fill("");
						await expect(button).toHaveAttribute("data-send-state", "stop");
						await button.tap();
						expect(await focusedIsField(page), "stop button").toBe(true);
					} finally {
						await page.context().close();
					}
				});

				test("keeps every control in the box while the keyboard is up, and the + sheet never carries run settings", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await keyboardUp(page);
						const { transcript, visible } = await chromePx(page);
						expect(visible).toBe(508);
						expect(transcript, "keyboard-up transcript px").toBeGreaterThanOrEqual(300);
						await expect(runChip(page)).toBeVisible();
						await capture(page, "keyboard-up", engine, theme, lang);
						await plus(page).tap();
						const rows = page.locator("[data-action-sheet] [data-menu-item]");
						await expect(rows.filter({ hasText: /Tool approval|도구 승인/ })).toHaveCount(0);
						await page.keyboard.press("Escape");
						// Tool approval is two taps: the Run chip, an option.
						await openRun(page);
						await page.locator("[data-approval-option='always-ask']").tap();
						await expect.poll(() => unhandled(page)).toContain("rpc:set_setting");
						await page.keyboard.press("Escape");
						await field(page).fill("one\ntwo\nthree");
						const fieldBox = await boxOf(field(page));
						expect(fieldBox.height).toBeLessThanOrEqual(508 - 120);
					} finally {
						await page.context().close();
					}
				});

				test("keeps every setting reachable in landscape", async () => {
					const page = await openPhone(engine, { lang, theme, width: 844, height: 390 });
					try {
						await capture(page, "landscape-idle", engine, theme, lang);
						await openRun(page);
						await expect(page.locator("[data-delegation-option]").first()).toBeAttached();
						await page.keyboard.press("Escape");
						await keyboardUp(page, 190);
						const box = await boxOf(page.locator(".omp-composer-box"));
						expect(box.y + box.height).toBeLessThanOrEqual(190 + 1);
					} finally {
						await page.context().close();
					}
				});

				test("shows the lane as a text chip beside Stop and Send while a turn runs, with the field at full width", async () => {
					const page = await openPhone(engine, { lang, theme });
					try {
						await setRunning(page, true);
						await expect(page.locator("[data-send-mode]")).toBeVisible();
						await capture(page, "running", engine, theme, lang);
						await field(page).fill("and also lint it");
						expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(330);
						await field(page).fill("");
						const running = await layout(page);
						await setRunning(page, false);
						const idle = await layout(page);
						expect(idle.field?.x).toBe(running.field?.x);
						expect(idle.send).toEqual(running.send);
						expect(idle.box?.y).toBe(running.box?.y);
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
						// The Run chip sits 4 px from +: its reach stops at the midpoint, so + is 30 px wide.
						await reach(plus(page), "+", 30);
						await reach(sendSlot(page).locator("button"), "Send/mic", 44);
						for (const locator of [runChip(page), modelChip(page), contextRing(page)]) {
							await reach(locator, "row chip", 30);
							for (const size of await hitSizes(locator)) expect(size.visual.height).toBeLessThanOrEqual(28.5);
						}
						for (const size of await hitSizes(plus(page))) expect(size.visual.width).toBeLessThanOrEqual(28.5);
						for (const locator of [
							plus(page),
							sendSlot(page).locator("button").first(),
							runChip(page),
							modelChip(page),
						]) {
							// The row scrolls sideways: a control past its edge is scrolled to first, as a finger would.
							await locator.first().scrollIntoViewIfNeeded();
							expect(await ownShare(locator)).toBe(1);
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
						await page.locator("[data-composer-input]").first().focus();
						await page.keyboard.press("Control+g");
						const region = page.locator(".omp-composer-region--expanded");
						await expect(region).toBeVisible();
						await expect(runChip(page)).toBeVisible();
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

				test("shows typing and multiline drafts in the open box, growing only upwards", async () => {
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
			test(`${width}x${height}: one box, nothing overflows`, async () => {
				const page = await openPhone(engine, { width, height });
				try {
					const box = await boxOf(page.locator(".omp-composer-box"));
					expect(box.x + box.width).toBeLessThanOrEqual(width);
					expect(
						await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
					).toBeLessThanOrEqual(0);
					expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(width - 60);
					await capture(page, `idle-${width}`, engine);
					await setRunning(page, true);
					await field(page).fill("and also lint it");
					expect((await boxOf(field(page))).width).toBeGreaterThanOrEqual(120);
					await capture(page, `running-draft-${width}`, engine);
				} finally {
					await page.context().close();
				}
			});
		}
	});
}
