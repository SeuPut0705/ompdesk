/**
 * Built-in prompt suggestions on the fake omp (e2e/fixture/rpc-ui.ts serves the bridge's
 * `next_prompt_*` methods and pushes `next_prompt_update` / `next_prompt_config`; its answers are
 * scripted through `OMP_GUI_TEST_NEXT_PROMPT`). Covers the placeholder and chips after a turn,
 * inline ghost text and what it costs, the Settings switches (live, persisted), the legacy
 * `next-prompt` widget, and the footer hint when the small model is missing. A paired host's tab
 * following the host's pref is not covered here: it needs the two-app remote harness
 * (e2e/remote-flows.e2e.ts) and the push is unit-tested in main.
 * Captures (light/dark × en/ko): placeholder + chips, ghost text, the footer hint and the
 * Settings › Agent behavior row, under the test's output directory.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";
import { capture, exitApp, launchApp, pressShortcutUntilVisible, recordsOfType, variants } from "./harness";

type Language = "en" | "ko";
type Theme = "light" | "dark";

const CANDIDATES = ["Run the tests", "Commit these changes", "Explain what you changed"] as const;
const GHOST = " and explain why";
/** INLINE_DEBOUNCE_MS (resources/gui-bridge/modes/next-prompt-contracts.ts) plus a margin: a request that would be made has been made. */
const DEBOUNCE_WINDOW_MS = 1_200;

const TEXT = {
	en: {
		group: "Suggested messages",
		chip: (index: number, text: string) => `Suggested message ${index}: ${text}`,
		noModel: "Suggestions are off: no small model is set up",
	},
	ko: {
		group: "추천 메시지",
		chip: (index: number, text: string) => `추천 메시지 ${index}: ${text}`,
		noModel: "제안이 꺼져 있어요: 작은 모델이 설정되지 않았어요",
	},
} as const;

interface Launched {
	app: ElectronApplication;
	page: Page;
	profile: string;
	desktop: string;
	record: string;
	errors: string[];
}

interface LaunchOptions {
	language?: Language;
	theme?: Theme;
	prefs?: Record<string, unknown>;
	/** `OMP_GUI_TEST_NEXT_PROMPT`. */
	script?: Record<string, unknown>;
	/** Relaunch on an existing profile (its prefs.json is kept). */
	profile?: string;
}

let launches = 0;

async function launch(options: LaunchOptions = {}): Promise<Launched> {
	const profile =
		options.profile ?? (await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-next-prompt-"))));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const record = path.join(profile, `commands-${++launches}.jsonl`);
	if (!options.profile) {
		await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({
				language: options.language ?? "en",
				themeName: options.theme ?? "light",
				firstRunComplete: true,
				...options.prefs,
			}),
		);
	}
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_NEXT_PROMPT: JSON.stringify(options.script ?? {}),
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
		.toBe("ready");
	return { app, page, profile, desktop, record, errors };
}

async function finish(launched: Launched, removeProfile = true): Promise<void> {
	await exitApp(launched.app);
	if (removeProfile) await fs.rm(launched.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function count(file: string, type: string): Promise<number> {
	return (await recordsOfType(file, type)).length;
}

/** The debounce window has passed on the page's own clock: any request the draft would make is already recorded. */
async function quiet(page: Page, ms = DEBOUNCE_WINDOW_MS): Promise<void> {
	const start = await page.evaluate(() => performance.now());
	await page.waitForFunction(([from, span]) => performance.now() - from >= span, [start, ms] as const, {
		polling: 50,
	});
}

function composer(page: Page): Locator {
	return page.locator(".omp-composer-input").first();
}

function chips(page: Page, language: Language = "en"): Locator {
	return page.getByRole("group", { name: TEXT[language].group }).locator("button[data-next-chip]");
}

/** Send one plain prompt and wait until its reply is in and the run is over (`replies` = replies so far, this one included). */
async function runTurn(page: Page, replies: number): Promise<void> {
	const input = composer(page);
	await input.fill("hello there");
	await input.press("Enter");
	await expect(page.getByText("Local fixture reply")).toHaveCount(replies, { timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
}

async function openAgentSettings(page: Page): Promise<Locator> {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="agent"]').click();
	return settings;
}

async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-settings-page]")).toHaveCount(0);
}

function suggestionsSwitch(settings: Locator): Locator {
	return settings.locator("#setting-gui-nextPromptSuggestions").getByRole("switch");
}

function inlineSwitch(settings: Locator): Locator {
	return settings.locator("#setting-gui-nextPromptInline").getByRole("switch");
}

test("after a turn the best candidate is the placeholder, the others are chips, and every way to take one works", async () => {
	test.setTimeout(150_000);
	const launched = await launch();
	try {
		const { page } = launched;
		const input = composer(page);
		await runTurn(page, 1);
		await expect(input).toHaveAttribute("placeholder", CANDIDATES[0]);
		const group = page.getByRole("group", { name: TEXT.en.group });
		await expect(group).toBeVisible();
		await expect(chips(page)).toHaveCount(2);
		await expect(chips(page).nth(0)).toHaveAccessibleName(TEXT.en.chip(1, CANDIDATES[1]));
		await expect(chips(page).nth(1)).toHaveAccessibleName(TEXT.en.chip(2, CANDIDATES[2]));

		// A click fills the composer and focuses it.
		await chips(page).nth(0).click();
		await expect(input).toHaveValue(CANDIDATES[1]);
		await expect(input).toBeFocused();
		await expect(chips(page)).toHaveCount(0);
		await input.fill("");
		await expect(chips(page)).toHaveCount(2);

		// Tab and → accept the placeholder.
		await input.focus();
		await page.keyboard.press("Tab");
		await expect(input).toHaveValue(CANDIDATES[0]);
		await input.fill("");
		await input.focus();
		await page.keyboard.press("ArrowRight");
		await expect(input).toHaveValue(CANDIDATES[0]);
		await input.fill("");

		// ↓ moves into the chips, → moves along them, Enter picks one and hands focus back.
		await input.focus();
		await page.keyboard.press("ArrowDown");
		await expect(chips(page).nth(0)).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(chips(page).nth(1)).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(input).toHaveValue(CANDIDATES[2]);
		await expect(input).toBeFocused();
		await input.fill("");

		// Esc on a focused chip goes back without filling.
		await input.focus();
		await page.keyboard.press("ArrowDown");
		await expect(chips(page).nth(0)).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(input).toBeFocused();
		await expect(input).toHaveValue("");

		// Alt+1 / Alt+2 fill chip 1 / 2; Alt+3 has no third chip here.
		await page.keyboard.press("Alt+Digit1");
		await expect(input).toHaveValue(CANDIDATES[1]);
		await input.fill("");
		await page.keyboard.press("Alt+Digit2");
		await expect(input).toHaveValue(CANDIDATES[2]);
		await input.fill("");
		await page.keyboard.press("Alt+Digit3");
		await expect(input).toHaveValue("");

		// Typing hides the chips.
		await input.pressSequentially("x");
		await expect(chips(page)).toHaveCount(0);
		await input.fill("");
		await expect(chips(page)).toHaveCount(2);

		// A started run hides them and the placeholder.
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
		await expect(chips(page)).toHaveCount(0);
		await expect(input).not.toHaveAttribute("placeholder", CANDIDATES[0]);
		expect(launched.errors).toEqual([]);
	} finally {
		await finish(launched);
	}
});

// Reported: chips cut with "…" in the real app. A candidate is at most 48 characters in Korean (MAX_CANDIDATE_CHARS_CJK);
// two chips that long take a row each and show whole, on one line, with the full text as the tooltip.
test("the longest Korean candidates fit their chips whole, one line each, with the text as the tooltip", async () => {
	test.setTimeout(120_000);
	const longest = [
		"대화 언어를 꺼 둔 상태에서도 한국어 메시지면 한국어 제목이 바로 나오도록 다시 고쳐줘",
		"세션 제목 언어 수정이 끝나면 실제 한국어 세션으로 한 번 더 확인하고 결과 꼭 알려줘",
	];
	for (const text of longest) expect(text).toHaveLength(48);
	const launched = await launch({ language: "ko", script: { candidates: ["제목 다시 만들어줘", ...longest] } });
	try {
		const { page } = launched;
		await runTurn(page, 1);
		const shown = chips(page, "ko");
		await expect(shown).toHaveCount(2);
		for (const [index, text] of longest.entries()) {
			const chip = shown.nth(index);
			await expect(chip).toHaveAttribute("title", text);
			const label = chip.locator(".omp-next-chip-text");
			await expect(label).toHaveText(text);
			const fit = await label.evaluate(element => ({
				truncated: element.scrollWidth > element.clientWidth,
				oneLine:
					getComputedStyle(element).whiteSpace === "nowrap" && element.scrollHeight <= element.clientHeight + 1,
			}));
			expect(fit).toEqual({ truncated: false, oneLine: true });
		}
		await capture(page, "chips-longest-ko");
		expect(launched.errors).toEqual([]);
	} finally {
		await finish(launched);
	}
});

test("the Settings switches hide suggestions live, reach the tab, and persist across a relaunch", async () => {
	test.setTimeout(240_000);
	const launched = await launch();
	let relaunched: Launched | undefined;
	try {
		const { page, record } = launched;
		const input = composer(page);
		const ghost = page.locator("[data-inline-ghost]");
		await runTurn(page, 1);
		await expect(input).toHaveAttribute("placeholder", CANDIDATES[0]);
		await expect(chips(page)).toHaveCount(2);

		// The inline sub-switch alone: ghost text goes, placeholder and chips stay.
		let settings = await openAgentSettings(page);
		await expect(suggestionsSwitch(settings)).toHaveAttribute("aria-checked", "true");
		await expect(inlineSwitch(settings)).toHaveAttribute("aria-checked", "true");
		await inlineSwitch(settings).click();
		await expect(inlineSwitch(settings)).toHaveAttribute("aria-checked", "false");
		await expect
			.poll(async () =>
				(await recordsOfType(record, "next_prompt_set")).map(({ suggestions, inline }) => ({
					suggestions,
					inline,
				})),
			)
			.toContainEqual({ suggestions: true, inline: false });
		await closeSettings(page);
		await expect(input).toHaveAttribute("placeholder", CANDIDATES[0]);
		await expect(chips(page)).toHaveCount(2);
		await input.click();
		await page.keyboard.type("please refactor this");
		await quiet(page);
		await expect(ghost).toHaveCount(0);
		expect(await count(record, "next_prompt_inline")).toBe(0);
		await input.fill("");

		// The main switch: placeholder, chips and ghost text go, and the tab's bridge is told.
		settings = await openAgentSettings(page);
		await suggestionsSwitch(settings).click();
		await expect(suggestionsSwitch(settings)).toHaveAttribute("aria-checked", "false");
		await expect(inlineSwitch(settings)).toBeDisabled();
		await expect
			.poll(async () => (await recordsOfType(record, "next_prompt_set")).map(({ suggestions }) => suggestions))
			.toContain(false);
		await closeSettings(page);
		await expect(input).not.toHaveAttribute("placeholder", CANDIDATES[0]);
		await expect(chips(page)).toHaveCount(0);
		await runTurn(page, 2);
		await quiet(page, 800);
		await expect(input).not.toHaveAttribute("placeholder", CANDIDATES[0]);
		await expect(chips(page)).toHaveCount(0);
		// Turn the inline sub-switch back on underneath: still no ghost, no request.
		settings = await openAgentSettings(page);
		await expect(inlineSwitch(settings)).toBeDisabled();
		await closeSettings(page);
		await input.click();
		await page.keyboard.type("please refactor this");
		await quiet(page);
		await expect(ghost).toHaveCount(0);
		expect(await count(record, "next_prompt_inline")).toBe(0);
		await fs.access(path.join(launched.desktop, "prefs.json"));
		await expect
			.poll(
				async () =>
					JSON.parse(await fs.readFile(path.join(launched.desktop, "prefs.json"), "utf8")).nextPromptSuggestions,
			)
			.toBe(false);
		await exitApp(launched.app);

		// A relaunch keeps it off: the switch, the spawn env and the composer all agree.
		relaunched = await launch({ profile: launched.profile });
		const again = relaunched.page;
		await runTurn(again, 1);
		await quiet(again, 800);
		await expect(composer(again)).not.toHaveAttribute("placeholder", CANDIDATES[0]);
		await expect(chips(again)).toHaveCount(0);
		settings = await openAgentSettings(again);
		await expect(suggestionsSwitch(settings)).toHaveAttribute("aria-checked", "false");
		expect(relaunched.errors).toEqual([]);
		expect(launched.errors).toEqual([]);
	} finally {
		await finish(relaunched ?? launched);
	}
});

// Screenshots only (the flows they show are the tests above): every variant waits for OMP_GUI_VARIANTS=1.
for (const language of variants(["en", "ko"] as const, () => false))
	for (const theme of ["light", "dark"] as const) {
		test(`captures: placeholder, chips and ghost text (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const launched = await launch({ language, theme });
			try {
				const { page } = launched;
				const input = composer(page);
				await runTurn(page, 1);
				await expect(input).toHaveAttribute("placeholder", CANDIDATES[0]);
				await expect(chips(page, language)).toHaveCount(2);
				await expect(chips(page, language).nth(0)).toHaveAccessibleName(TEXT[language].chip(1, CANDIDATES[1]));
				await capture(page, `${language}-${theme}-placeholder-chips`);

				await input.click();
				await page.keyboard.type("please refactor this");
				const ghost = page.locator("[data-inline-ghost]");
				await expect(ghost).toBeVisible();
				await expect(ghost.locator(".omp-inline-ghost-text")).toHaveText(GHOST);
				await capture(page, `${language}-${theme}-ghost`);
				expect(launched.errors).toEqual([]);
			} finally {
				await finish(launched);
			}
		});

		test(`captures: footer hint and the Settings row (${language} ${theme})`, async () => {
			test.setTimeout(150_000);
			const launched = await launch({ language, theme, script: { fail: "no_model", legacy: true } });
			try {
				const { page } = launched;
				await runTurn(page, 1);
				await expect(page.locator("[data-next-prompt-unavailable]")).toHaveText(TEXT[language].noModel);
				await capture(page, `${language}-${theme}-footer-hint`);

				const settings = await openAgentSettings(page);
				const row = settings.locator("#setting-gui-nextPromptSuggestions");
				await row.scrollIntoViewIfNeeded();
				await expect(suggestionsSwitch(settings)).toHaveAttribute("aria-checked", "true");
				await expect(inlineSwitch(settings)).toHaveAttribute("aria-checked", "true");
				await expect(settings.locator("[data-next-prompt-legacy]")).toBeVisible();
				await capture(page, `${language}-${theme}-settings-row`);
				expect(launched.errors).toEqual([]);
			} finally {
				await finish(launched);
			}
		});
	}
