import * as fs from "node:fs/promises";
import type { Page } from "@playwright/test";
import type { Look } from "./responsive-audit";

// The surfaces the responsive audit opens, split by owner (A: sidebar, transcript, composer and its popovers, side
// panels; B: Settings, Stats/Usage, Agents, Autopilot, Schedules, remote devices, model compare, Mobile web, every
// dialog, sheet, toast and banner). A surface opens through the stores a click would set (`window.__stores`,
// src/renderer/dev-harness/boot.ts) or a click on the real control, then waits for `ready` (a selector) or a beat.

export interface Surface {
	id: string;
	area: "A" | "B";
	/** What it is, for the report. */
	title: string;
	open(page: Page, look: Look): Promise<void>;
	/** A selector that must be visible before measuring (the surface failed to open when it never is). */
	ready?: string;
	/** Extra query for the harness page (`&pwa=push`); surfaces sharing a page need the same query. */
	query?: string;
	/** Milliseconds to wait after `open` for data and motion to settle. */
	settle?: number;
	/** Measure the density figures (chrome share, gutter) too. */
	density?: boolean;
	/** Whether the surface exists at this look (a phone folds some controls behind ⋯); skipped otherwise. */
	when?: (look: Look) => boolean;
	/**
	 * The parity sheet (`bun run parity`, e2e/parity.e2e.ts) can capture this surface: every view first shows this
	 * session of the host (`work`: a session with one answered turn, `bot`: the bot's, `reply`: a session whose answer
	 * shows what an agent presents in a reply, e2e/fixture/rpc-ui.ts `replyImages`), then `open` runs. Only for a
	 * surface whose `open` and `ready` work on a real window (a click on a real control or nothing), never through
	 * `window.__stores`, which only the dev harness has.
	 */
	parity?: {
		session: ParitySession;
		/**
		 * Before it is captured, the host's bot leaves a session running on the paired computer, opened by a conversation
		 * it has since ended and whose tab is closed, and that computer runs a session of its own (e2e/parity.e2e.ts).
		 */
		remoteChild?: boolean;
		/**
		 * Runs in each view after its capture (also when the capture failed): puts back what `open` changed beyond the
		 * page (the host's settings, a take waiting on the fake omp), so the next surface starts from the same host.
		 */
		after?(page: Page): Promise<void>;
	};
}

export type ParitySession = "work" | "bot" | "reply";

/** The fake omp's voice script (`voiceScript`, e2e/fixture/rpc-ui.ts); e2e/parity.e2e.ts names the file. */
async function scriptVoice(script: Record<string, unknown>): Promise<void> {
	const file = process.env.OMP_GUI_TEST_VOICE_FILE;
	if (!file) throw new Error("the voice call surfaces need OMP_GUI_TEST_VOICE_FILE (e2e/parity.e2e.ts sets it)");
	await fs.writeFile(file, JSON.stringify(script));
}

/** A fake microphone's tone: silent for `silentMs` (the call measures its noise floor), then sounding for `toneMs`. */
interface Tone {
	silentMs: number;
	toneMs: number;
}

/** The one utterance of the call surfaces that end speech: 1.2 s of floor, then 1.5 s of sound. */
const SHORT_UTTERANCE: Tone = { silentMs: 1200, toneMs: 1500 };

/**
 * The page's microphone is an oscillator through a gain that follows `tone` from the moment the page asks for it
 * (`getUserMedia`: a call's start, a dictation take's start), so the app hears it as a person speaking.
 */
async function fakeMicrophone(page: Page, tone: Tone): Promise<void> {
	await page.evaluate(tone => {
		const getUserMedia = async () => {
			const context = new AudioContext();
			await context.resume().catch(() => undefined);
			const oscillator = context.createOscillator();
			oscillator.frequency.value = 180;
			const gain = context.createGain();
			gain.gain.value = 0;
			const destination = context.createMediaStreamDestination();
			oscillator.connect(gain).connect(destination);
			oscillator.start();
			gain.gain.setValueAtTime(0.3, context.currentTime + tone.silentMs / 1000);
			gain.gain.setValueAtTime(0, context.currentTime + (tone.silentMs + tone.toneMs) / 1000);
			return destination.stream;
		};
		// A phone page on plain http has no `navigator.mediaDevices` at all.
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: Object.assign(navigator.mediaDevices ?? {}, { getUserMedia }),
		});
	}, tone);
}

/** Start a voice call on the bot's pane. `tone`: the page's microphone. */
async function startBotCall(page: Page, tone?: Tone): Promise<void> {
	if (tone) await fakeMicrophone(page, tone);
	await page.locator("[data-bot-call-start]").first().click();
}

/**
 * Ends a call surface on its view: a call stays on until its person ends it, and one left running shows its bar over
 * every surface after it. A dropped script answers a reply it held with no text.
 */
async function endBotCall(page: Page): Promise<void> {
	const bar = page.locator("[data-bot-call-bar]");
	if ((await bar.count()) > 0) {
		await bar.locator("[data-bot-call-end]").click();
		await bar.waitFor({ state: "detached", timeout: 10_000 });
	}
	await scriptVoice({});
}

/** Write omp's `stt.enabled` the way the Settings row does (`set_setting`; the composer reads it back on `config_update`). */
async function setDictation(page: Page, enabled: boolean): Promise<void> {
	const reply = await page.evaluate(enabled => window.omp.rpc.setSetting("stt.enabled", enabled), enabled);
	if (!reply.success) throw new Error(`stt.enabled was not written: ${reply.error}`);
}

/**
 * A composer dictation take in Korean, its first wait on the Korean speech model's download (held at 42 %): sound at
 * once, a click on the composer's mic (the toolbar's `Start dictation` on the desktop and a paired computer's view of it,
 * the empty Send slot on the phone), and once the take's clock reads 0:01 (a second of audio, which the take needs
 * before it transcribes anything) the toolbar's stop, which on the phone too is the one that ends a running take.
 */
async function startKoreanDictationTake(page: Page): Promise<void> {
	await scriptVoice({ prepare: { language: "ko", percent: 42 } });
	await fakeMicrophone(page, { silentMs: 0, toneMs: 60_000 });
	await setDictation(page, true);
	await page.locator('button[aria-label="Start dictation"]').first().click({ timeout: 15_000 });
	await page.locator('[data-dictation="recording"]', { hasText: "0:01" }).waitFor({ timeout: 15_000 });
	await page.locator('button[aria-label="Stop recording and insert text"]').first().click({ timeout: 15_000 });
}

/** Ends a dictation surface on the host: Esc discards a take still recording, a dropped script answers a held one with no text. */
async function endDictationTake(page: Page): Promise<void> {
	if ((await page.locator('[data-dictation="recording"]').count()) > 0) await page.keyboard.press("Escape");
	await scriptVoice({});
	await page.locator("[data-dictation]").waitFor({ state: "detached", timeout: 10_000 });
	await setDictation(page, false);
}

/** Put one extension-UI request (a card) in front of the focused session. */
async function request(page: Page, payload: Record<string, unknown>): Promise<void> {
	await page.evaluate(request => {
		const store = window.__stores?.extensionUi?.getState() as { pushRequest(value: unknown): void } | undefined;
		store?.pushRequest({ type: "extension_ui_request", ...request });
	}, payload);
}

/** Call a ui-store action by name. */
async function ui(page: Page, action: string, ...args: unknown[]): Promise<void> {
	await page.evaluate(
		({ action, args }) => {
			const state = window.__stores?.ui?.getState() as Record<string, (...rest: unknown[]) => void> | undefined;
			const run = state?.[action];
			if (!run) throw new Error(`ui store has no ${action}`);
			run(...args);
		},
		{ action, args },
	);
}

/** Put a prompt of the web host's sheet layer (`?host=1` pages) in front of the person. */
async function hostPrompt(page: Page, prompt: Record<string, unknown>): Promise<void> {
	await page.evaluate(prompt => {
		const store = window.__stores?.hostUi?.getState() as { push(value: unknown): void } | undefined;
		store?.push({ ...prompt, host: window.__hostActions, resolve: () => {} });
	}, prompt);
}

/** Set the updater's status, as main's `updater:status` push does. */
async function updater(page: Page, status: Record<string, unknown>): Promise<void> {
	await page.evaluate(status => window.__stores?.updater?.setState({ status }), status);
}

const isPhone = (look: Look): boolean => look.width < 600;

/**
 * The soft keyboard comes up the way Chrome on Android shows it (`interactive-widget=resizes-content`): the layout
 * viewport loses the keyboard's height while a field has focus (lib/keyboard-inset.ts `layoutKeyboardOpen`), about 40 %
 * of a phone and a third of a tablet. iOS only shrinks the visual viewport, which a browser test cannot do; the
 * shell's `--kb-inset` answers both the same way. Portrait only: a sideways tablet this short reads as a phone.
 */
async function keyboardUp(page: Page, look: Look, focus: string): Promise<void> {
	await page.locator(focus).first().click();
	const height = Math.round(look.height * (isPhone(look) ? 0.6 : 0.67));
	await page.setViewportSize({ width: look.width, height });
	await page.waitForFunction(() => document.documentElement.dataset.kb === "open", undefined, { timeout: 5_000 });
}
const keyboardLook = (look: Look): boolean => (look.device ?? "touch") === "touch" && look.orientation === "portrait";
/**
 * A portrait tablet at least 800 px wide docks the session list; a phone and the narrower tablet use the drawer. A phone
 * held sideways (844×390) is wider than 800 px but still a phone (`use-shell-mode.ts`: shorter than 500 px), drawer and
 * all: read as docked, the audit waited for a list it never opened.
 */
const sidebarDocked = (look: Look): boolean => look.width >= 800 && look.height >= 500;

async function openDrawer(page: Page, look: Look): Promise<void> {
	if (sidebarDocked(look)) return;
	await page.locator("button:visible:has(svg.lucide-menu)").first().click();
	await page.locator("[data-drawer]").waitFor({ state: "visible", timeout: 10_000 });
}

/**
 * The bot's row with its family opened by its chip (folded by default), and every device section but the one holding
 * that row folded, so its header's marks say what it hides.
 */
async function openBotFamily(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	const bot = page.locator("[data-sidebar-bot-row]").first();
	await bot.waitFor({ state: "visible", timeout: 30_000 });
	const chip = page.locator("[data-sidebar-bot-row] [data-sidebar-subagents-toggle][aria-expanded='false']").first();
	if ((await chip.count()) > 0) await chip.click();
	const botSection = page.locator("[data-sidebar-device]:has([data-sidebar-bot-row])").first();
	const kept = (await botSection.count()) > 0 ? await botSection.getAttribute("data-sidebar-device") : "local";
	const toggles = page.locator("[data-sidebar-device-toggle][aria-expanded='true']");
	const open = await toggles.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-sidebar-device-toggle")));
	for (const id of open)
		if (id !== kept) await page.locator(`[data-sidebar-device-toggle="${id}"][aria-expanded='true']`).click();
}

/** Settings › Models & accounts through the sidebar's Settings row and the section's own nav entry, as a person does; the local engine switch under Custom endpoints in view. */
async function openSettingsModels(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="models"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
	const row = page.locator("[data-settings-page] [data-local-engine-detect]");
	await row.waitFor({ state: "visible", timeout: 30_000 });
	await row.scrollIntoViewIfNeeded();
}

async function openSettings(page: Page, section: string): Promise<void> {
	await ui(page, "openSettings", section);
	const nav = page.locator(`[data-settings-section="${section.split(":")[0]}"]`);
	// A phone lists the sections first and pushes the chosen one; a tablet already shows it.
	if (await nav.isVisible().catch(() => false)) await nav.click();
	// A sub-target (`memory:pages`): the click above landed on the section's first view, so go to the sub-view.
	if (section.includes(":")) await ui(page, "setSettingsSection", section);
}

/** Every Settings section of `SETTINGS_NAV` (settings-catalog.ts). */
export const SETTINGS_SECTIONS = [
	"general",
	"appearance",
	"keyboard",
	"models",
	"agent",
	"memory",
	"tools",
	"permissions",
	"bot",
	"workspace",
	"schedules",
	"connections",
	"updates",
	"advanced",
] as const;

/** The side panel's views (`PANEL_TABS`); the other session views open as sheets (`VIEW_SHEETS`, stores/ui.ts). */
const PANELS = ["terminal", "diff", "preview", "files"] as const;
const VIEW_SHEETS = ["jobs", "plan", "logs", "tree", "work"] as const;

const DIALOG_FLAGS: ReadonlyArray<{ id: string; action: string; args?: unknown[]; title: string }> = [
	{ id: "dialog-rename", action: "openRenameDialog", title: "Rename session" },
	{ id: "dialog-changelog", action: "openChangelog", title: "Changelog" },
	{ id: "dialog-whats-new", action: "openWhatsNew", args: ["0.36.1", "0.35.0"], title: "What's new" },
	{ id: "dialog-feedback", action: "openFeedback", title: "Feedback" },
	{ id: "dialog-command-palette", action: "openCommandPalette", title: "Command palette" },
	{ id: "dialog-theme-picker", action: "openThemePicker", title: "Theme picker" },
	{ id: "dialog-quick-open", action: "openQuickOpen", title: "Quick open" },
	{ id: "dialog-share-session", action: "openShareSession", title: "Share session" },
	{ id: "dialog-active-tools", action: "openActiveTools", title: "Active tools" },
	{ id: "dialog-force-tool", action: "openForceTool", title: "Force tool" },
	{ id: "dialog-import", action: "openImportDialog", title: "Import foreign sessions" },
	{ id: "dialog-copy-selector", action: "openCopySelector", title: "Copy selector" },
	{ id: "dialog-benchmark", action: "openBenchmark", title: "Model benchmark" },
	{ id: "dialog-model-setup", action: "openModelSetup", title: "Model setup assistant" },
	{ id: "dialog-debug", action: "openDebug", title: "Debug console" },
	{ id: "dialog-worktree", action: "openWorktreeDialog", title: "New worktree" },
];

export const SURFACES: readonly Surface[] = [
	// ── Area A: sidebar, transcript, composer, panels ─────────────────────────────────────────
	{
		id: "session-idle",
		area: "A",
		title: "Session: header, transcript, dock and composer at rest (with density figures)",
		density: true,
		open: async page => {
			await page.waitForSelector("[data-transcript-kind]", { timeout: 15_000 });
		},
		ready: "[data-composer-input]",
		parity: { session: "work" },
	},
	{
		id: "reply-images",
		area: "A",
		title: "A reply showing the changed look: a before/after pair and a gallery of three screenshots, by absolute path",
		open: async page => {
			await page
				.locator("[data-zoomable-image]")
				.first()
				.evaluate(image => image.scrollIntoView({ block: "start" }));
		},
		ready: "[data-zoomable-image] img",
		settle: 900,
		// The audits' harness page has no such reply; the parity sheet asks the fake omp for it.
		when: () => false,
		parity: { session: "reply" },
	},
	{
		id: "reply-images-zoom",
		area: "A",
		title: "The reply's after picture opened full size from its pair, its partner one step away",
		open: async page => {
			await page
				.getByRole("button", { name: /After: one project open/ })
				.first()
				.click();
		},
		ready: "[role='dialog'] [data-image-viewer] img",
		settle: 900,
		when: () => false,
		parity: { session: "reply" },
	},
	{
		id: "bot-bar",
		area: "A",
		title: "The bot's session (?bot=1): its bar over the conversation and an open decision docked above the composer",
		query: "&bot=1",
		open: async () => {},
		ready: "[data-bot-bar] [data-bot-state]",
		parity: { session: "bot" },
	},
	{
		id: "bot-call-preparing",
		area: "A",
		title: "A voice call with the bot getting Korean recognition ready: the language's speech model downloading, its progress in the call bar",
		open: async page => {
			await scriptVoice({ prepare: { language: "ko", percent: 42 } });
			await startBotCall(page);
		},
		ready: '[data-bot-call-phase="preparing"] [data-bot-call-progress]',
		// The fake omp's voice script exists only in the parity sheet's two apps; the audits' harness page has no call.
		when: () => false,
		parity: { session: "bot", after: endBotCall },
	},
	{
		id: "bot-call-speaking",
		area: "A",
		title: "A voice call in Korean: what the person said heard, and the bot's reply being spoken",
		open: async page => {
			await scriptVoice({ language: "ko", transcript: "하늘은 무슨 색인가요?", replySeconds: 60 });
			await startBotCall(page, SHORT_UTTERANCE);
		},
		ready: '[data-bot-call-phase="speaking"]',
		when: () => false,
		parity: { session: "bot", after: endBotCall },
	},
	{
		id: "bot-call-hearing",
		area: "A",
		title: "A voice call in Korean on Whisper: the person talking, heard without running words",
		open: async page => {
			// Whisper large-v3-turbo is offline: no running words while the person speaks. The tone sounds for a minute, so
			// the call stays on the one utterance.
			await scriptVoice({ language: "ko", transcript: "하늘은 무슨 색인가요?", partials: false, holdStop: true });
			await startBotCall(page, { silentMs: 1200, toneMs: 60_000 });
		},
		ready: '[data-bot-call-phase="hearing"]',
		when: () => false,
		parity: { session: "bot", after: endBotCall },
	},
	{
		id: "bot-call-transcribing",
		area: "A",
		title: "A voice call in Korean on Whisper: the speech ended, its words being transcribed once",
		open: async page => {
			// The fake omp holds `stt_stream_stop` unanswered: the call waits for the one transcription.
			await scriptVoice({ language: "ko", transcript: "하늘은 무슨 색인가요?", partials: false, holdStop: true });
			await startBotCall(page, SHORT_UTTERANCE);
		},
		ready: "[data-bot-call-bar][data-bot-call-transcribing]",
		when: () => false,
		parity: { session: "bot", after: endBotCall },
	},
	{
		id: "composer-dictation-preparing",
		area: "A",
		title: "Composer dictation in Korean, its first take waiting for the Korean speech model's download, with its progress",
		open: startKoreanDictationTake,
		ready: '[data-dictation="transcribing"] [data-dictation-download]',
		when: () => false,
		parity: { session: "work", after: endDictationTake },
	},
	{
		id: "composer-dictation-downloaded",
		area: "A",
		title: "Composer dictation in Korean after the Korean speech model's download: the take being transcribed on it",
		open: async page => {
			await startKoreanDictationTake(page);
			await page.locator('[data-dictation="transcribing"] [data-dictation-download]').waitFor({ timeout: 15_000 });
			// The download is done; the fake omp keeps the transcription running.
			await scriptVoice({ holdTranscribe: true });
		},
		ready: '[data-dictation="transcribing"]:not(:has([data-dictation-download]))',
		when: () => false,
		parity: { session: "work", after: endDictationTake },
	},
	{
		id: "board-strip",
		area: "A",
		title: "Work board (busy session, ?board=busy): docked beside the transcript where the pane holds it (an iPad sideways), else the status strip under the header, expanded",
		query: "&board=busy",
		open: async page => {
			// The busy fixture's turn, question and goal land 1.5 s after boot (dev-harness/boot.ts).
			const chip = page.locator("[data-work-chip][data-state='waiting']");
			const docked = page.locator(".omp-work-board-slot [data-board-section='needs']");
			await chip.or(docked).first().waitFor({ state: "visible", timeout: 15_000 });
			if ((await chip.count()) > 0 && (await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
		},
		ready: "[data-work-board-panel]",
		settle: 600,
	},
	{
		id: "board-strip-open",
		area: "A",
		title: "Work board strip with every zone opened from its summary line: the rows a phone reaches with a tap more",
		query: "&board=busy",
		open: async page => {
			const chip = page.locator("[data-work-chip][data-state='waiting']");
			const docked = page.locator(".omp-work-board-slot [data-board-section='needs']");
			await chip.or(docked).first().waitFor({ state: "visible", timeout: 15_000 });
			if ((await chip.count()) === 0) return;
			if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
			// Current work's rows are a lazy chunk: its line arrives last, after the others.
			const lines = page.locator("[data-work-strip-panel] [data-board-summary]");
			await page.locator("[data-work-strip-panel] [data-board-section='current']").waitFor({ timeout: 15_000 });
			for (let left = await lines.count(); left > 0; left = await lines.count()) await lines.first().click();
		},
		ready: "[data-work-board-panel]",
		settle: 600,
	},
	{
		id: "sidebar",
		area: "A",
		title: "Session list: the drawer on a phone, docked beside the page from 800 px",
		open: openDrawer,
		ready: "[data-tour='sessions'], [data-drawer]",
		parity: { session: "work" },
	},
	{
		id: "sidebar-family",
		area: "A",
		title: "Session list with the bot's family open (a session its ended conversation left running on the paired computer) and the other computer's section folded to its count",
		open: openBotFamily,
		ready: "[data-sidebar-bot-row]",
		// Two paired apps only: the parity sheet sets it up (`remoteChild`); the audits' harness page has no paired computer.
		when: () => false,
		parity: { session: "work", remoteChild: true },
	},
	{
		id: "transcript-top",
		area: "A",
		title: "Transcript scrolled to its first turn",
		open: async page => {
			await page.evaluate(() => {
				const row = document.querySelector("[data-transcript-kind]");
				let node = row?.parentElement ?? null;
				while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
				if (node) node.scrollTop = 0;
			});
		},
	},
	{
		id: "transcript-stress",
		area: "A",
		title: "Transcript at the stress turns: long URL, wide table, long code line, diff, mermaid, long tool paths",
		open: async page => {
			await page.evaluate(() => {
				const row = document.querySelector("[data-transcript-kind]");
				let node = row?.parentElement ?? null;
				while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
				if (node) node.scrollTop = node.scrollHeight;
			});
		},
		settle: 900,
	},
	{
		id: "image-viewer",
		area: "A",
		title: "A picture full size (the stress turns' mermaid diagram) under its own bar",
		open: async page => {
			await page.evaluate(() => {
				const row = document.querySelector("[data-transcript-kind]");
				let node = row?.parentElement ?? null;
				while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
				if (node) node.scrollTop = node.scrollHeight;
			});
			const picture = page.locator("[data-zoomable-image]").last();
			await picture.waitFor({ state: "visible", timeout: 15_000 });
			await picture.click();
		},
		ready: "[data-image-viewer-head]",
		settle: 600,
	},
	{
		id: "composer-mode-plan",
		area: "A",
		title: "Mode popover › Plan",
		open: page => ui(page, "openModes", "plan"),
	},
	{
		id: "composer-mode-goal",
		area: "A",
		title: "Mode popover › Goal",
		open: page => ui(page, "openModes", "goal"),
	},
	{
		id: "model-picker",
		area: "A",
		title: "Model picker",
		open: page => ui(page, "openModelPicker"),
		ready: "[data-model-option]",
	},
	{
		id: "composer-slash-menu",
		area: "A",
		title: "Slash command menu",
		open: async page => {
			const input = page.locator("[data-composer-input]");
			await input.click();
			await input.pressSequentially("/", { delay: 30 });
		},
	},
	{
		id: "composer-at-menu",
		area: "A",
		title: "@ file menu",
		open: async page => {
			const input = page.locator("[data-composer-input]");
			await input.click();
			await input.pressSequentially("@", { delay: 30 });
		},
	},
	{
		id: "composer-long-draft",
		area: "A",
		title: "Composer holding a long multi-line draft",
		open: async page => {
			const input = page.locator("[data-composer-input]");
			await input.click();
			await input.fill(
				Array.from(
					{ length: 8 },
					(_, line) => `Line ${line + 1} of a long draft that wraps past the width of a narrow phone screen`,
				).join("\n"),
			);
		},
	},
	{
		id: "composer-keyboard",
		area: "A",
		title: "Composer with the soft keyboard up and a draft typed",
		query: "&kb=1",
		when: keyboardLook,
		open: async (page, look) => {
			await keyboardUp(page, look, "[data-composer-input]");
			await page.locator("[data-composer-input]").fill("A short draft typed with the keyboard up");
		},
		ready: "[data-composer-input]",
	},
	{
		id: "composer-keyboard-slash",
		area: "A",
		title: "Slash command menu with the soft keyboard up",
		query: "&kb=1",
		when: keyboardLook,
		open: async (page, look) => {
			await keyboardUp(page, look, "[data-composer-input]");
			await page.locator("[data-composer-input]").pressSequentially("/", { delay: 30 });
		},
	},
	{
		id: "dialog-rename-keyboard",
		area: "B",
		title: "Rename dialog with the soft keyboard up on its field",
		query: "&kb=1",
		when: keyboardLook,
		open: async (page, look) => {
			await ui(page, "openRenameDialog");
			await keyboardUp(page, look, "[role='dialog'] input");
		},
		settle: 700,
	},
	...PANELS.map(
		(panel): Surface => ({
			id: `panel-${panel}`,
			area: "A",
			title: `Side panel › ${panel}`,
			open: async page => {
				await ui(page, "setPanelTab", panel);
			},
			ready: "[data-sheet-panel], [data-panel-tabbar], .omp-panel-topbar",
			settle: 900,
		}),
	),
	...VIEW_SHEETS.map(
		(view): Surface => ({
			id: `sheet-${view}`,
			area: "A",
			title: `View sheet › ${view}`,
			open: async page => {
				await ui(page, "openViewSheet", view);
			},
			ready: `[data-view-sheet="${view}"]`,
			settle: 900,
		}),
	),
	{
		id: "panel-files-viewer",
		area: "A",
		title: "Files viewer on a changed file",
		open: page => ui(page, "openFilePreview", "src/renderer/components/layout/sidebar/Sidebar.tsx"),
		settle: 1200,
	},

	// ── Area B: Settings, centers, dialogs ────────────────────────────────────────────────────
	...SETTINGS_SECTIONS.filter(section => section !== "models").map(
		(section): Surface => ({
			id: `settings-${section}`,
			area: "B",
			title: `Settings › ${section}`,
			open: page => openSettings(page, section),
			ready: "[data-settings-page]",
			settle: 900,
		}),
	),
	{
		id: "settings-models",
		area: "B",
		title: "Settings › Models & accounts, scrolled to the local engine switch under Custom endpoints",
		open: openSettingsModels,
		ready: "[data-settings-page] [data-local-engine-detect]",
		settle: 900,
		parity: { session: "work" },
	},
	// Settings › Memory: every tab, and the list → detail states of Pages, Handoffs and Sessions.
	...(["overview", "search", "pages", "handoffs", "sessions", "profile", "maintenance"] as const).map(
		(tab): Surface => ({
			id: `settings-memory-${tab}`,
			area: "B",
			title: `Settings › Memory › ${tab}`,
			open: async page => {
				await openSettings(page, `memory:${tab}`);
				if (tab === "search") {
					const box = page.locator("[data-memory-search] input[type=search], [data-memory-search] input").first();
					await box.fill("sqlite");
					await box.press("Enter");
					await page.locator("[data-memory-hit]").first().waitFor({ timeout: 10_000 });
				}
				if (tab === "maintenance") {
					await page.locator("[data-memory-lint-run]").click();
					await page.locator("[data-memory-sweep-preview]").click();
					await page.locator("[data-memory-sweep-result]").waitFor({ timeout: 10_000 });
				}
			},
			ready: "[data-settings-page] [data-memory-tab]",
			settle: 900,
		}),
	),
	...(
		[
			["pages", "[data-memory-page]", "[data-memory-reader]"],
			["handoffs", "[data-memory-handoff]", "[data-memory-handoff-detail]"],
			["sessions", "[data-memory-session]", "[data-memory-observations]"],
		] as const
	).map(
		([tab, row, detail]): Surface => ({
			id: `settings-memory-${tab}-detail`,
			area: "B",
			title: `Settings › Memory › ${tab}, one open (a phone shows the detail alone)`,
			open: async page => {
				await openSettings(page, `memory:${tab}`);
				await page.locator(row).first().click();
				await page.locator(detail).first().waitFor({ timeout: 10_000 });
			},
			ready: "[data-settings-page] [data-memory-tab]",
			settle: 900,
		}),
	),
	{
		id: "settings-list",
		area: "B",
		title: "Settings section list (a phone's first page)",
		open: async page => {
			await ui(page, "openSettings");
		},
		ready: "[data-settings-page]",
	},
	{
		id: "settings-connections-pwa",
		area: "B",
		title: "Settings › Devices & connections with the installed-app notification row",
		query: "&pwa=push",
		open: page => openSettings(page, "connections"),
		ready: "[data-settings-page]",
		settle: 900,
	},
	...(["live", "definitions", "prs", "github"] as const).map(
		(tab): Surface => ({
			id: `agents-${tab}`,
			area: "B",
			title: `Agents › ${tab}`,
			open: page => ui(page, "openAgents", tab),
			settle: 900,
		}),
	),
	{
		id: "stats",
		area: "B",
		title: "Insights › Stats (this session)",
		open: page => ui(page, "openInsights", "stats", "session"),
		settle: 900,
	},
	{
		id: "stats-all",
		area: "B",
		title: "Insights › Stats (all sessions)",
		open: page => ui(page, "openInsights", "stats", "all"),
		settle: 1200,
	},
	{
		id: "usage",
		area: "B",
		title: "Insights › Usage",
		open: page => ui(page, "openInsights", "usage"),
		settle: 900,
	},
	{
		id: "autopilot-start",
		area: "B",
		title: "Mode popover › Autopilot (start sheet)",
		open: page => ui(page, "openModes", "autopilot"),
	},
	{
		id: "autopilot-board",
		area: "B",
		title: "Work board › an Autopilot run (docked, or the strip expanded)",
		open: async page => {
			await page.evaluate(() => {
				const now = Date.now();
				const store = window.__stores?.autopilot?.getState() as { apply: (status: unknown) => void } | undefined;
				store?.apply({
					active: true,
					state: "running",
					cycle: 3,
					branch: "autopilot/2026-10-21",
					baseBranch: "main",
					now: {
						n: 3,
						area: "performance",
						title: "Cache the session list's first read",
						startedAt: now - 60_000,
					},
					activeMs: 1_800_000,
					cycles: [1, 2].map(n => ({
						n,
						area: n === 1 ? "bugs" : "docs",
						title: n === 1 ? "Fix the stale draft after a tab switch" : "Explain the release cadence",
						summary: "",
						verify: n === 1 ? "green" : "red",
						commit: n === 1 ? "1a9f1c2deadbeef" : undefined,
						followups: [],
						children: [],
						startedAt: now - (4 - n) * 600_000,
						durationMs: 252_000,
						tokens: 212_000,
						usd: 0.42,
						compactions: 0,
					})),
					redStreak: 2,
					followups: ["Retry the flaky resize test once the drawer settles", "Keyboard access in settings"],
					totals: { tokens: 424_000, usd: 0.84 },
					ship: {
						policy: {
							autoPush: false,
							autoRelease: { on: false, cadence: { kind: "agent" } },
							remote: "origin",
							land: true,
						},
						queue: [],
					},
				});
			});
			await ui(page, "revealWorkBoard", null);
		},
		settle: 900,
	},
	...DIALOG_FLAGS.map(
		(dialog): Surface => ({
			id: dialog.id,
			area: "B",
			title: dialog.title,
			open: page => ui(page, dialog.action, ...(dialog.args ?? [])),
			settle: 700,
		}),
	),
	{
		id: "toasts",
		area: "B",
		title: "Toast stack: every variant, one with an action and one long message",
		open: async page => {
			await page.evaluate(() => {
				const toast = window.__stores?.toast?.getState() as { push(input: unknown): void } | undefined;
				const long =
					"A long message that runs well past one line on a phone, with /Users/dev/projects/ompdesk/src/renderer/components/layout/sidebar/Sidebar.tsx in it";
				toast?.push({
					variant: "info",
					title: "Info",
					message: "Copied the link",
					durationMs: Number.POSITIVE_INFINITY,
				});
				toast?.push({ variant: "success", message: long, durationMs: Number.POSITIVE_INFINITY });
				toast?.push({
					variant: "warning",
					title: "Warning",
					message: long,
					action: { label: "Undo", run: () => {} },
					durationMs: Number.POSITIVE_INFINITY,
				});
				toast?.push({
					variant: "error",
					title: "Error",
					message: long,
					detail: `Error: ${long}`,
					durationMs: Number.POSITIVE_INFINITY,
				});
			});
		},
		settle: 600,
	},
	{
		id: "composer-run-settings",
		area: "A",
		title: "Run settings (mode, thinking, approval, delegation): a popover, a bottom sheet on a phone",
		open: page => page.locator("[data-run-settings-trigger]").first().click(),
	},
	{
		id: "composer-context-usage",
		area: "A",
		title: "Context usage: a popover, a bottom sheet on a phone",
		open: page => page.locator(".omp-context-usage-trigger").first().click(),
	},
	{
		id: "composer-attach-menu",
		area: "A",
		title: "Attach and more menu (the composer's +)",
		open: page =>
			page
				.locator(".omp-composer-toolbar > button, .omp-composer-toolbar > .omp-composer-scroll > button")
				.first()
				.click(),
	},
	{
		id: "sidebar-row-menu",
		area: "A",
		title: "A session row's action menu",
		open: async (page, look) => {
			await openDrawer(page, look);
			// A mouse shows the row's ⋯ on hover; a finger always has it.
			const row = page.locator(".omp-list-row:has([data-sidebar-row-menu])").first();
			if ((look.device ?? "touch") !== "touch") await row.hover();
			await row.locator("[data-sidebar-row-menu]").first().click();
		},
	},
	{
		id: "card-ask",
		area: "A",
		title: "Ask card: a question with options, a multi-select and a recommendation",
		open: page =>
			request(page, {
				id: "audit-ask",
				method: "ask",
				questions: [
					{
						id: "q1",
						header: "Where should the fix go?",
						question:
							"The flaky row can be fixed in the test, in the component, or in both places. Which do you prefer?",
						options: [
							{
								label: "In the test only",
								description: "Wait for the row before asserting; no product change.",
							},
							{ label: "In the component", description: "Paint the rows synchronously on mount." },
							{ label: "Both", description: "Belt and braces, at the cost of a larger diff." },
						],
						recommended: 0,
					},
					{
						id: "q2",
						question: "Which checks should run afterwards?",
						multi: true,
						options: [{ label: "Unit tests" }, { label: "Type check" }, { label: "Biome" }],
					},
				],
			}),
	},
	{
		id: "card-approval",
		area: "A",
		title: "Tool approval card with a long command",
		open: page =>
			request(page, {
				id: "audit-approval",
				method: "select",
				title: "Allow tool: bash\nbunx vitest run src/renderer/components/layout/sidebar src/renderer/components/layout/composer --repeat 10 --reporter=verbose",
				options: ["Approve", "Deny"],
			}),
	},
	{
		id: "card-input",
		area: "A",
		title: "Input and confirm cards",
		open: async page => {
			await request(page, {
				id: "audit-input",
				method: "input",
				title: "What should the branch be called?",
				placeholder: "feature/short-name",
			});
			await request(page, {
				id: "audit-confirm",
				method: "confirm",
				title: "Overwrite the file?",
				message: "src/renderer/components/layout/sidebar/Sidebar.tsx already exists.",
			});
		},
	},
	{
		id: "dialog-plan-approval",
		area: "B",
		title: "Plan approval dialog",
		open: page =>
			page.evaluate(() => {
				const store = window.__stores?.planApproval?.getState() as
					| { showProposal(proposal: unknown): void }
					| undefined;
				store?.showProposal({
					planFilePath: "/Users/dev/projects/ompdesk/.omp/plans/fix-flaky-sidebar.md",
					title: "Fix the flaky sidebar test",
					planContent: `# Plan\n\n1. Reproduce the flake with \`--repeat 10\`\n2. Wait for the row to mount before asserting\n3. Run the suite ten times\n\n| Step | Owner |\n| --- | --- |\n| Reproduce | agent |\n| Fix | agent |\n\n\`\`\`ts\nawait waitFor(() => expect(rowFor("Session /work/alpha/mine")).toBeTruthy());\n\`\`\``,
					options: ["execute", "compact", "keep_context", "save"],
				});
			}),
		settle: 700,
	},
	{
		id: "dialog-schedule-new",
		area: "B",
		title: "Settings › Schedules › New schedule dialog",
		open: async page => {
			await openSettings(page, "schedules");
			await page.locator("[data-schedule-new]").first().click();
		},
		settle: 700,
	},
	{
		id: "settings-mobile-web-devices",
		area: "B",
		title: "Settings › Connections scrolled to Mobile web's devices and the device's push row",
		query: "&pwa=push",
		open: async page => {
			await openSettings(page, "connections");
			await page.locator("[data-web-device-section]").first().scrollIntoViewIfNeeded();
		},
		settle: 700,
	},
	{
		id: "card-whats-new",
		area: "B",
		title: "What's new card in the composer's corner",
		open: page => ui(page, "showWhatsNewCard", "0.36.1", "0.35.0"),
	},
	{
		id: "banner-update-error",
		area: "B",
		title: "Update banner: the updater failed",
		open: page =>
			updater(page, {
				state: "error",
				message: "Could not reach the update server. Check the connection and try again.",
				detail: "getaddrinfo ENOTFOUND github.com",
			}),
	},
	{
		id: "banner-update-ready",
		area: "B",
		title: "Update banner: an update is downloaded",
		open: page => updater(page, { state: "downloaded", version: "0.37.0", mode: "relaunch" }),
	},
	{
		id: "host-path-actions",
		area: "B",
		title: "Host sheet: a file the agent named (open / reveal / download)",
		query: "&host=1",
		open: page =>
			hostPrompt(page, {
				kind: "openPath",
				path: "/Users/dev/projects/ompdesk/src/renderer/components/layout/sidebar/Sidebar.tsx",
			}),
	},
	{
		id: "host-browser-folder",
		area: "B",
		title: "Host sheet: the computer's folder browser",
		query: "&host=1",
		open: page =>
			hostPrompt(page, {
				kind: "browse",
				mode: "folder",
				title: "Open a project folder",
				defaultPath: "/Users/dev/projects",
			}),
		settle: 700,
	},
	{
		id: "host-browser-file",
		area: "B",
		title: "Host sheet: the computer's file browser",
		query: "&host=1",
		open: page =>
			hostPrompt(page, { kind: "browse", mode: "file", title: "Attach a file", defaultPath: "/Users/dev/projects" }),
		settle: 700,
	},
	{
		id: "host-editor",
		area: "B",
		title: "Host sheet: edit on the computer",
		query: "&host=1",
		open: page =>
			hostPrompt(page, {
				kind: "editor",
				content: "A long line of text to edit on the computer, past the width of a phone screen.\nSecond line.",
			}),
	},
	{
		id: "host-save-image",
		area: "B",
		title: "Host sheet: save an image (phone or computer)",
		query: "&host=1",
		open: page =>
			hostPrompt(page, { kind: "saveImage", name: "diagram.png", mime: "image/png", base64: "iVBORw0KGgo=" }),
	},
	{
		id: "host-models-config",
		area: "B",
		title: "Host sheet: the agent's models file",
		query: "&host=1",
		open: page => hostPrompt(page, { kind: "models" }),
		settle: 700,
	},
	{
		id: "host-quit",
		area: "B",
		title: "Host sheet: quit confirmation",
		query: "&host=1",
		open: page => hostPrompt(page, { kind: "quit" }),
	},
	{
		id: "host-update",
		area: "B",
		title: "Host sheet: update confirmation",
		query: "&host=1",
		open: page => hostPrompt(page, { kind: "update" }),
	},
	...(["ios-share", "prompt", "samsung-menu", "firefox-menu"] as const).map(
		(guidance): Surface => ({
			id: `host-install-${guidance}`,
			area: "B",
			title: `PWA install sheet (${guidance})`,
			query: "&host=1",
			open: page => hostPrompt(page, { kind: "install", guidance }),
		}),
	),
];

export function surfacesFor(filter: { area?: string; only?: RegExp }): Surface[] {
	return SURFACES.filter(
		surface => (!filter.area || surface.area === filter.area) && (!filter.only || filter.only.test(surface.id)),
	);
}

export { isPhone };
