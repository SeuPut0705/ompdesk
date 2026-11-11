import * as fs from "node:fs/promises";
import type { Locator, Page } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { type Look, touchLook } from "./responsive-audit";

/** A control's words in the look's language, so a Korean look finds by name what an English one does. */
const say = (look: Look, key: string): string => {
	const words = (look.lang === "ko" ? ko : en)[key];
	if (!words) throw new Error(`no ${look.lang} text for ${key}`);
	return words;
};

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
	 * session of the host (`work`: a session with one answered turn, `reply`: a session whose turns
	 * show what an agent presents in a reply, e2e/fixture/rpc-ui.ts `replyImages` and `REPLY_SHOWCASE`), then `open` runs. Only for a
	 * surface whose `open` and `ready` work on a real window (a click on a real control or nothing), never through
	 * `window.__stores`, which only the dev harness has.
	 */
	parity?: {
		session: ParitySession;
		/** B's work session leaves a child running on A, which also runs a session of its own (e2e/parity.e2e.ts). */
		remoteChild?: boolean;
		/**
		 * Before it is captured, B runs a second session, "Parity roster", that every view opened once and then left for
		 * the shown session, so each holds a tab of it it does not show; its turn then starts two subagents
		 * (e2e/parity.e2e.ts). Its row must count them with no click.
		 */
		hiddenRoster?: boolean;
		/**
		 * Before it is captured, B's work session opens "Parity cross-project" in another folder of B's (`seuoffice`) and
		 * leaves its turn running, so it is a row under its opener and of its own project (e2e/parity.e2e.ts).
		 */
		crossProject?: boolean;
		/**
		 * Before it is captured, B has a session, "Parity folder gone", whose folder (`moda-office`) was deleted after
		 * its one answered turn (e2e/parity.e2e.ts).
		 */
		folderMissing?: boolean;
		/**
		 * Runs in each view after its capture (also when the capture failed): puts back what `open` changed beyond the
		 * page (the host's settings, a take waiting on the fake omp) or left open in the window beyond what Escape and
		 * opening the next session close (the side panel), so the next surface starts from the same host and window.
		 */
		after?(page: Page): Promise<void>;
		/**
		 * A part of the surface each view must have mounted and inside its transcript's visible box before the sheet
		 * measures it (the sideways-scroll check measures only what is mounted, and a capture of the transcript's end
		 * shows nothing of it).
		 */
		inView?: string;
		/**
		 * False while the fake omp was not started with the data this surface shows (a flag of e2e/fixture/rpc-ui.ts):
		 * the sheet then has no such surface, and `--both-orders` leaves it out.
		 */
		available?(): boolean;
	};
}

export type ParitySession = "work" | "reply" | "steer";

/** The fake omp's voice script (`voiceScript`, e2e/fixture/rpc-ui.ts); e2e/parity.e2e.ts names the file. */
async function scriptVoice(script: Record<string, unknown>): Promise<void> {
	const file = process.env.OMP_GUI_TEST_VOICE_FILE;
	if (!file) throw new Error("the dictation surfaces need OMP_GUI_TEST_VOICE_FILE (e2e/parity.e2e.ts sets it)");
	await fs.writeFile(file, JSON.stringify(script));
}

/** A fake microphone's tone: silent for `silentMs`, then sounding for `toneMs`. */
interface Tone {
	silentMs: number;
	toneMs: number;
}

/**
 * The page's microphone is an oscillator through a gain that follows `tone` from the moment the page asks for it
 * (`getUserMedia`: a dictation take's start), so the app hears it as a person speaking.
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

/** The fake omp's start script (`startFile`, e2e/fixture/rpc-ui.ts); e2e/parity.e2e.ts names the file. */
async function scriptStart(script: Record<string, unknown>): Promise<void> {
	const file = process.env.OMP_GUI_TEST_START_FILE;
	if (!file) throw new Error("the slow start surface needs OMP_GUI_TEST_START_FILE (e2e/parity.e2e.ts sets it)");
	await fs.writeFile(file, JSON.stringify(script));
}

/** The tab the view shows: its id and status as the view's own `window.omp` lists them. */
async function shownTab(page: Page): Promise<{ tabId: string; status: string } | undefined> {
	const tab = (await page.evaluate(() => window.omp.tabs.list())).find(entry => entry.active);
	return tab ? { tabId: tab.tabId, status: String(tab.status) } : undefined;
}

/**
 * Restarts the host's omp for the session the view shows. No control restarts a ready session (the banner and Settings
 * offer Restart only on a session that is not), so it is `window.omp.sidecar.restart`, the call that Restart makes,
 * with the view's own tab (a paired computer's and the phone's go to the host through the link).
 */
async function restartShownTab(page: Page): Promise<void> {
	const tab = await shownTab(page);
	if (!tab) throw new Error("the view shows no session to restart");
	await page.evaluate(tabId => window.omp.sidecar.restart({ tabId }), tab.tabId);
}

/**
 * Restarts the omp while its fake holds `get_state` (the host's `OMP_GUI_START_SLOW_MS` is 1.5 s): the banner shows
 * once the omp has not answered for that long.
 */
async function restartSlowStart(page: Page): Promise<void> {
	await scriptStart({ holdGetState: true });
	await restartShownTab(page);
	await page.getByText("omp is taking long to start", { exact: true }).first().waitFor({ timeout: 30_000 });
	await page.getByText("fixture: loading models (held by the test)").first().waitFor({ timeout: 15_000 });
}

/** The title bar's status as the tab reads while it waits for its turn to start (the words are its accessible name on a phone). */
const WAITING_TO_START = '.omp-titlebar-status[aria-label="Waiting to start"]';

/**
 * Restarts the omp while its fake ignores the stop (`holdExit`): the replacement waits for the old omp to exit, which
 * main ends with SIGKILL after 5 s, so the tab reads "Waiting to start" for that long.
 */
async function restartQueuedStart(page: Page): Promise<void> {
	await scriptStart({ holdExit: true });
	await restartShownTab(page);
}

/** Lets the held omp answer and waits until the view's session is ready again (an `error` on the way fails the surface). */
async function endStartHold(page: Page): Promise<void> {
	await scriptStart({});
	const until = Date.now() + 60_000;
	for (;;) {
		const status = (await shownTab(page))?.status;
		if (status === "error") throw new Error("the session went to error while it started slowly");
		if (status === "ready") break;
		if (Date.now() > until) throw new Error(`the session is still ${status} 60 s after the omp may answer`);
		await page.waitForTimeout(250);
	}
	await page
		.getByText("omp is taking long to start", { exact: true })
		.first()
		.waitFor({ state: "detached", timeout: 15_000 });
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

/**
 * Show the side panel's `view` by clicks a person makes, on a real window as on the harness: the title bar's Side
 * panel button when the panel is closed, then the view's button (the panel's top bar; a phone's tab bar at its foot).
 */
async function openPanelView(page: Page, look: Look, view: "diff" | "files"): Promise<void> {
	const button = page
		.locator(".omp-panel-topbar:visible, [data-panel-tabbar]:visible")
		.getByRole("button", { name: say(look, `panel.tabs.${view}`), exact: true })
		.first();
	if (!(await button.isVisible().catch(() => false)))
		await page
			.getByRole("button", { name: say(look, "titlebar.sidePanel"), exact: true })
			.first()
			.click();
	await button.click();
}

/**
 * Closes the side panel a surface opened, by the panel's own close button. The open panel takes the place the work
 * board docks in, so the board of the surface after it folds into its strip.
 */
async function closePanelView(page: Page): Promise<void> {
	const close = page.locator("[data-panel-close]:visible").first();
	if (await close.isVisible().catch(() => false)) await close.click();
}

/**
 * Open the command palette by clicks: the sidebar's search button (Command palette), behind the phone's Open menu
 * drawer where the sidebar is one.
 */
async function clickCommandPalette(page: Page): Promise<void> {
	const entry = page.locator("[data-command-center-entry]:visible").first();
	if (!(await entry.isVisible().catch(() => false)))
		await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
	await entry.click();
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
 * Where the work board is its strip, not docked beside the transcript (`workBoardDocks`, work-board.ts): every phone,
 * tablet in portrait and the 1024 px tablet sideways keep the strip; an iPad from 1133 sideways and every desktop
 * window from 1100 dock it beside a column narrowed for it.
 */
const boardIsStrip = (look: Look): boolean => look.width < 1100;
/** The host's sheets are the paired web page's (`WebHostUi` renders nothing in the desktop app). */
const webPage = (look: Look): boolean => look.device !== "electron";

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
 * The menu of the project header the view's open session sits under: this computer's list, or the paired computer's
 * section for the host. A mouse right-clicks the header; a finger has no right click, so it taps the header's ⋯.
 */
async function openProjectMenu(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	const cwd = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.cwd;
	if (!cwd) throw new Error("no open session to find its project by");
	const folder = JSON.stringify(cwd);
	const header = page.locator(`[data-workspace-group=${folder}], [data-device-group=${folder}] .group\\/head`).first();
	if ((look.device ?? "touch") === "touch") await header.locator(".omp-sidebar-project-menu").click();
	else await header.click({ button: "right" });
}

/** Closes the menu or dialog a surface left open (Escape), so the next starts from the same window. */
async function closeOverlay(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
}

/** The work session's family open, with every other computer's section folded to its count. */
async function openRemoteFamily(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	const selector = ':is(.omp-sidebar-session-row, [data-device-session]):has-text("Parity work")';
	const row = page.locator(selector).first();
	await row.waitFor({ state: "visible", timeout: 30_000 });
	const chip = row.locator("[data-sidebar-subagents-toggle][aria-expanded='false']");
	if ((await chip.count()) > 0) await chip.click();
	await page
		.locator('[data-sidebar-family] [data-sidebar-opened-session]:has-text("Parity remote child")')
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
	const section = page.locator(`[data-sidebar-device]:has(${selector})`).first();
	const kept = (await section.count()) > 0 ? await section.getAttribute("data-sidebar-device") : "local";
	const toggles = page.locator("[data-sidebar-device-toggle][aria-expanded='true']");
	const open = await toggles.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-sidebar-device-toggle")));
	for (const id of open)
		if (id !== kept) await page.locator(`[data-sidebar-device-toggle="${id}"][aria-expanded='true']`).click();
}

/**
 * Keeps open only the sidebar section holding the project group whose folder ends with `folder` (this computer's, or
 * the paired computer's), expands that group and waits for `row`. A group with no open tab of the view's starts
 * folded, and one can fold again when what main says of its folder arrives (a folder found gone), so it is expanded
 * again until the row shows.
 */
async function showProjectRows(page: Page, look: Look, folder: string, row: string): Promise<void> {
	await openDrawer(page, look);
	const group = `:is([data-workspace-group$="${folder}"], [data-device-group$="${folder}"])`;
	await page.locator(group).first().waitFor({ state: "attached", timeout: 30_000 });
	const section = page.locator(`[data-sidebar-device]:has([data-device-group$="${folder}"])`).first();
	const kept = (await section.count()) > 0 ? await section.getAttribute("data-sidebar-device") : "local";
	const toggles = page.locator("[data-sidebar-device-toggle][aria-expanded='true']");
	const open = await toggles.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-sidebar-device-toggle")));
	for (const id of open)
		if (id !== kept) await page.locator(`[data-sidebar-device-toggle="${id}"][aria-expanded='true']`).click();
	const header = page
		.locator(
			`[data-workspace-group$="${folder}"] button[aria-expanded='false'], [data-device-group$="${folder}"] > .group\\/head button[aria-expanded='false']`,
		)
		.first();
	const target = page.locator(row).first();
	const until = Date.now() + 30_000;
	while (!(await target.isVisible())) {
		if (Date.now() > until) throw new Error(`no ${row} in the ${folder} group`);
		if ((await header.count()) > 0) await header.click();
		await page.waitForTimeout(250);
	}
	// Settled: the row has stayed put for a moment, so a click lands on it.
	await page.waitForTimeout(500);
	await target.waitFor({ state: "visible", timeout: 5_000 });
}

/** The work session's family open, and the project of the session it opened in another folder expanded. */
async function openOwnProject(page: Page, look: Look): Promise<void> {
	await showProjectRows(
		page,
		look,
		"seuoffice",
		':is([data-session-group$="seuoffice"] .omp-sidebar-session-row, [data-device-group$="seuoffice"] [data-device-session]):has-text("Parity cross-project")',
	);
	const chip = page
		.locator(
			':is(.omp-sidebar-session-row, [data-device-session]):has-text("Parity work") [data-sidebar-subagents-toggle][aria-expanded="false"]',
		)
		.first();
	if ((await chip.count()) > 0) await chip.click();
	await page
		.locator('[data-sidebar-opened-session]:has-text("Parity cross-project")')
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
}

/** The row of the session whose folder was deleted, marked missing, in its expanded project. */
async function openFolderMissing(page: Page, look: Look): Promise<void> {
	await showProjectRows(
		page,
		look,
		"moda-office",
		':is(.omp-sidebar-session-row, [data-device-session])[data-folder-missing]:has-text("Parity folder gone")',
	);
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

/** Settings › Agent behavior, scrolled to Computer use engine and the two macOS permission rows under it. */
async function openSettingsComputerUse(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="agent"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
	const row = page.locator("[data-settings-page] #setting-gui-macPermission-screen");
	await row.waitFor({ state: "visible", timeout: 30_000 });
	await page.locator("[data-settings-page] #setting-gui-computerUse").scrollIntoViewIfNeeded();
	await row.scrollIntoViewIfNeeded();
}

async function openSettingsGeneral(page: Page, look: Look): Promise<void> {
	await openDrawer(page, look);
	await page.locator('[data-destination="settings"]').first().click();
	const nav = page.locator('[data-settings-section="general"]');
	await nav.waitFor({ state: "visible", timeout: 15_000 });
	await nav.click();
	await page.locator("[data-settings-page] #setting-gui-language").waitFor({ state: "visible", timeout: 30_000 });
}

/** The model setup dialog through Settings › Models & accounts and its "Set up automatically" button, as a person opens it. */
async function openModelSetup(page: Page, look: Look): Promise<void> {
	await openSettingsModels(page, look);
	await page.locator("#settings-models-setup [data-model-setup-open]").click();
	await page
		.locator("[role=dialog] [data-model-setup-evidence] [aria-haspopup=listbox]")
		.waitFor({ state: "visible", timeout: 30_000 });
}

/** Press `shortcut` until `target` shows: the first press can land before the page's key handler is in place. */
async function pressUntilVisible(page: Page, shortcut: string, target: Locator): Promise<void> {
	for (let attempt = 0; attempt < 3 && !(await target.isVisible()); attempt++) {
		await page.keyboard.press(shortcut);
		await target.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
	}
	await target.waitFor({ state: "visible", timeout: 1_000 });
}

/**
 * A page through the palette's command (`stats` opens Stats › All sessions, `agents` Agents › Definitions; command
 * names are the same in every UI language), then the page's own tab by its id when one is named, so a Korean look
 * clicks the same tab. ⌥A for Agents missed now and then on a freshly loaded harness page; the palette did not.
 */
async function openPageTab(
	page: Page,
	command: "stats" | "agents",
	tab: "session" | "usage" | "live" | null,
): Promise<void> {
	// The palette's own field: another dialog a harness page left open has a combobox too.
	const search = page.locator('[role="dialog"]:has([data-palette-index]) [role="combobox"]');
	await pressUntilVisible(page, "ControlOrMeta+k", search);
	await search.fill(command);
	await search.press("Enter");
	const section = page.locator(`section[data-destination="${command === "stats" ? "insights" : "agents"}"]`);
	await section.waitFor({ state: "visible", timeout: 15_000 });
	if (!tab) return;
	await section.locator(`[role="tab"][data-tab-id="${tab}"]`).click();
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

/**
 * Scrolls `target` to the top of its transcript until it stays there. The rows around it are measured in the frames
 * after they mount and each measurement moves the view, so a place read right after the scroll says nothing: the
 * target is where the scroll put it only once it has not moved for ten frames (10 Nov 2026: a phone's view of the
 * showcase reply slid 759 px past its section after one scroll).
 */
async function holdAtTop(target: Locator): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt++) {
		const stayed = await target.evaluate(async element => {
			const frames = async (count: number) => {
				for (let frame = 0; frame < count; frame++) await new Promise(done => requestAnimationFrame(done));
			};
			element.scrollIntoView({ block: "start" });
			await frames(2);
			const placed = element.getBoundingClientRect().top;
			await frames(10);
			return element.isConnected && Math.abs(element.getBoundingClientRect().top - placed) <= 1;
		});
		if (stayed) return;
	}
}

/**
 * Brings the turn a person started with `prompt` to the top of its transcript, as a reader looking for it does: an
 * upward wheel first (a programmatic scroll alone leaves the transcript following its end, ChatStream's `pinned`,
 * released only by a wheel, touch, key or scrollbar gesture), then a view's height at a time, from where the view is
 * to the transcript's start and on to its end, until the turn is in the page.
 *
 * The transcript is virtualized: only the rows around the view are mounted (8 beyond it), so a part of a turn far
 * from the view is not there to wait for, click or scroll to. Every surface of the `reply` session names its turn
 * here first: once the session had seven turns, the surfaces of its first four waited 15 to 30 s each for a row that
 * never mounted, in the window and in the paired view (10 Nov 2026: 10 of the 48 parity surfaces, 482 of a capture's
 * 800 s).
 */
async function showTurn(page: Page, prompt: string): Promise<void> {
	const bubble = page.locator(".omp-user-bubble").getByText(prompt, { exact: true }).last();
	const scroller = page.locator(".omp-transcript-scroll").first();
	await scroller.evaluate(element =>
		element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })),
	);
	for (const direction of [-1, 1]) {
		while ((await bubble.count()) === 0) {
			const moved = await scroller.evaluate(async (element, by) => {
				const from = element.scrollTop;
				element.scrollTop = from + by * element.clientHeight;
				// The rows of the new view mount in the frames after the scroll.
				await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
				return element.scrollTop !== from;
			}, direction);
			if (!moved) break;
		}
	}
	await holdAtTop(bubble);
}

/**
 * Brings `target` of a reply whose turn is shown (`showTurn`) to the top of its transcript, once each of `drawn` (the
 * reply's math, its mermaid chart) is visible in the target's own row and every picture of a figure row has its
 * read's answer (the picture, or the failed chip with its reason).
 */
async function showInReply(page: Page, target: Locator, drawn: readonly string[] = []): Promise<void> {
	const row = page.locator(".omp-transcript-scroll [data-index]").filter({ has: target }).first();
	for (const selector of drawn) await row.locator(selector).last().waitFor({ state: "visible", timeout: 15_000 });
	await page
		.locator("[data-figure-row] figure:not(:has(img)):not(:has(> span[title]))")
		.first()
		.waitFor({ state: "detached", timeout: 15_000 });
	await holdAtTop(target);
}

/** The transcript's first row at the top of its view, reached the way `showTurn` reaches a turn (a wheel, then scrolls). */
async function showTranscriptStart(page: Page): Promise<void> {
	const scroller = page.locator(".omp-transcript-scroll").first();
	const first = scroller.locator('[data-index="0"]');
	await scroller.evaluate(element =>
		element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })),
	);
	for (let attempt = 0; attempt < 30 && (await first.count()) === 0; attempt++)
		await scroller.evaluate(async element => {
			element.scrollTop = 0;
			const mounted = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => mounted.resolve()));
			await mounted.promise;
		});
	await holdAtTop(first);
}

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
			await showTurn(page, "fixture reply images");
			await showInReply(page, page.locator("[data-zoomable-image]").first());
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
			await showTurn(page, "fixture reply images");
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
		id: "reply-media",
		area: "A",
		title: "A reply's files and figures: an svg figure, a video and a sound in their players, a table file's card",
		open: async page => {
			await showTurn(page, "fixture reply media");
			await page.locator(".markdown-body [data-file-card]").first().waitFor({ timeout: 15_000 });
			await showInReply(
				page,
				page
					.locator(".markdown-body h2")
					.filter({ hasText: /^\s*Media\s*$/ })
					.first(),
			);
		},
		ready: ".markdown-body video",
		settle: 900,
		when: () => false,
		parity: { session: "reply" },
	},
	{
		id: "reply-media-zoom",
		area: "A",
		title: "The reply's svg figure enlarged from its header",
		open: async page => {
			await showTurn(page, "fixture reply media");
			await page.locator(".markdown-body [data-figure='svg'] [data-figure-expand]").first().click();
		},
		ready: "[role='dialog'] [data-image-viewer] img",
		settle: 900,
		when: () => false,
		parity: { session: "reply" },
	},
	// Every other way a reply presents something, one heading of src/renderer/dev-harness/reply-showcase.ts each.
	...(
		[
			[
				"reply-text",
				"Text",
				"Prose with inline marks, a key-value list, numbered steps, a task list and a row of pictures whose files are gone",
			],
			["reply-tables", "Tables", "A comparison table with status marks, and a seven-column table"],
			["reply-code", "Code", "A long typed code line, a diff and a JSON fence"],
			["reply-callouts", "Callouts", "Alerts, a plain quote, a folded log and a rule"],
			["reply-math", "Math and diagrams", "Inline and block math, a mermaid chart and a footnote"],
		] as const
	).map(
		([id, heading, what]): Surface => ({
			id,
			area: "A",
			title: `A reply's ${heading.toLowerCase()}: ${what}`,
			open: async page => {
				await showTurn(page, "fixture reply components");
				await showInReply(
					page,
					page
						.locator(".markdown-body h2")
						.filter({ hasText: new RegExp(`^\\s*${heading}\\s*$`) })
						.first(),
					[".markdown-body .katex-display", ".markdown-body [data-figure] img"],
				);
			},
			ready: `.markdown-body h2:text-is("${heading}")`,
			settle: 900,
			// Each view shows its section; the Text one, the row whose chips spilled their paths sideways.
			parity: {
				session: "reply",
				inView:
					heading === "Text"
						? '.markdown-body [data-figure-row]:has-text("Before: one word per line")'
						: `.markdown-body h2:text-is("${heading}")`,
			},
		}),
	),
	{
		id: "reply-narration",
		area: "A",
		title: "A run whose reply writes to the person beside its tool call: the text stays under the card holding the call",
		open: async page => {
			await showTurn(page, "fixture narrated");
			await page.getByText("Narrated run finished.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: "[data-transcript-kind='process']",
		settle: 900,
		when: () => false,
		parity: { session: "reply" },
	},
	{
		id: "reply-steer",
		area: "A",
		title: "A steer the person sent while the run worked: their message in the chat between the run's two cards",
		open: async page => {
			await showTurn(page, "fixture steered");
			await page.getByText("Steered run finished.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: "[data-transcript-kind='process']",
		settle: 900,
		when: () => false,
		parity: { session: "steer" },
	},
	...(
		[
			[
				"work-turn-recovered",
				"fixture turn recovered",
				"The tests pass now.",
				"a failed test a later card's rerun fixed",
			],
			[
				"work-turn-unfixed",
				"fixture turn unfixed",
				"One test still fails.",
				"a failed test that was the turn's last",
			],
		] as const
	).map(
		([id, prompt, answer, what]): Surface => ({
			id,
			area: "A",
			title: `A turn's two work cards around a reply's narration: ${what}, and a note for an error gone past`,
			open: async page => {
				await showTurn(page, prompt);
				await page.getByText(answer, { exact: true }).last().waitFor({ timeout: 15_000 });
			},
			ready: "[data-transcript-kind='process']",
			settle: 900,
			when: () => false,
			parity: { session: "reply" },
		}),
	),
	{
		id: "tool-agent-desktop",
		area: "A",
		title: "agent-desktop's tool calls: the snapshot tree unfolded, the typed line and the screenshot",
		open: async page => {
			await showTurn(page, "fixture agent-desktop");
			await page.getByText("agent-desktop run finished.", { exact: true }).last().waitFor({ timeout: 15_000 });
			const card = page.locator(".omp-execution-group").last();
			const head = card.locator(".omp-execution-group-header").first();
			if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
			// The snapshot's tree is what the surface is about; the typed line and the picture open beside it.
			for (const command of ["screenshot", "type", "snapshot"]) {
				const row = card
					.locator(".omp-tool-card")
					.filter({ hasText: new RegExp(`Desktop · ${command}`) })
					.first()
					.locator("button[aria-expanded]")
					.first();
				if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
			}
			// The picture and the lazy tree settle the rows' heights (the transcript is virtualized): scroll again after
			// each, as a reader would, until the tree stays at the top.
			await card.locator("[data-zoomable-image] img").first().waitFor({ state: "visible", timeout: 15_000 });
			const tree = card.locator('[data-tool-agent-desktop="tree"]').first();
			for (let attempt = 0; attempt < 3; attempt++) {
				// An upward wheel first, as `showInReply` does: a programmatic scroll leaves the transcript pinned to its end.
				await page
					.locator(".omp-transcript-scroll")
					.first()
					.evaluate(scroller =>
						scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true })),
					);
				await tree.evaluate(element => element.scrollIntoView({ block: "start" }));
				await page.waitForTimeout(300);
			}
		},
		ready: '[data-tool-agent-desktop="tree"] [role="tree"] [data-tree-id]',
		settle: 900,
		// The audits' harness page has no such run; the parity sheet asks the fake omp for it.
		when: () => false,
		parity: { session: "reply", inView: '[data-tool-agent-desktop="tree"]' },
	},
	{
		id: "reply-usage",
		area: "A",
		title: "The usage row under a reply: model, tokens, cache, cost, duration, first token, speed and time on one line",
		// The fake omp's agent-desktop run (`tool-agent-desktop`) ends on a reply carrying every segment.
		open: async page => {
			// A surface before may have scrolled the transcript up: back to its end, where this reply is, as a reader
			// does (a scroll of our own would leave "Jump to latest" over the row).
			// The pill stays in the page while pinned, hidden from the pointer and the accessibility tree.
			const latest = page.locator("[data-jump-to-latest]:not([aria-hidden])").first();
			if ((await latest.count()) > 0) await latest.click();
			await latest.waitFor({ state: "detached", timeout: 15_000 });
			await page.getByText("agent-desktop run finished.", { exact: true }).last().waitFor({ timeout: 15_000 });
		},
		ready: ".omp-usage-row",
		settle: 900,
		// The audits' harness page shows usage rows only with the preference on; the parity sheet asks the fake omp.
		when: () => false,
		parity: { session: "reply", inView: ".omp-usage-row" },
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
		id: "session-slow-start",
		area: "A",
		title: "A session whose omp has not answered its first state for a while: the amber banner with omp's stderr line and Restart, nothing failed",
		open: restartSlowStart,
		ready: "text=omp is taking long to start",
		// The fake omp's start script exists only in the parity sheet's two apps; the audits' harness page has no omp.
		when: () => false,
		parity: { session: "work", after: endStartHold },
	},
	{
		id: "session-queued-start",
		area: "A",
		title: 'A session whose replacement omp waits for the one it stopped to exit: the title bar reads "Waiting to start", no banner',
		open: restartQueuedStart,
		ready: WAITING_TO_START,
		// The fake omp's start script exists only in the parity sheet's two apps; the audits' harness page has no omp.
		when: () => false,
		parity: { session: "work", after: endStartHold },
	},
	{
		id: "board-strip",
		area: "A",
		title: "Work board strip (busy session, ?board=busy), expanded: under the header on a phone, above the composer elsewhere, where the pane cannot dock the board (docked: board-strip-open)",
		query: "&board=busy",
		when: boardIsStrip,
		open: async page => {
			// The busy fixture's turn, question and goal land 1.5 s after boot (dev-harness/boot.ts).
			const chip = page.locator("[data-work-chip][data-state='waiting']");
			await chip.waitFor({ state: "visible", timeout: 15_000 });
			if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
		},
		ready: "[data-work-strip-panel]",
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
		title: "Session list with the work session's child running on the paired computer and the other computer's section folded to its count",
		open: openRemoteFamily,
		ready: '[data-sidebar-family] [data-sidebar-opened-session]:has-text("Parity remote child")',
		when: () => false,
		parity: { session: "work", remoteChild: true },
	},
	{
		id: "sidebar-roster",
		area: "A",
		title: "Session list with a session this view holds but does not show running two subagents: its row counts them with no click",
		open: openDrawer,
		ready: ':is(.omp-sidebar-session-row, [data-device-session]):has-text("Parity roster") [data-family-running="2"]',
		// Two paired apps only: the parity sheet sets it up (`hiddenRoster`); the audits' harness page has no such session.
		when: () => false,
		parity: { session: "work", hiddenRoster: true },
	},
	{
		id: "sidebar-own-project",
		area: "A",
		title: "Session list with a session the work session opened in another folder: under its opener and in its own project",
		open: openOwnProject,
		ready: ':is([data-session-group$="seuoffice"] .omp-sidebar-session-row, [data-device-group$="seuoffice"] [data-device-session]):has-text("Parity cross-project")',
		// Two paired apps only: the parity sheet sets it up (`crossProject`); the audits' harness page has no such session.
		when: () => false,
		parity: { session: "work", crossProject: true },
	},
	{
		id: "sidebar-folder-missing",
		area: "A",
		title: "Session list with a session whose folder was deleted: its row says the folder is missing",
		open: openFolderMissing,
		ready: ':is(.omp-sidebar-session-row, [data-device-session]):has-text("Parity folder gone") [data-folder-missing], :is(.omp-sidebar-session-row, [data-device-session])[data-folder-missing]:has-text("Parity folder gone")',
		when: () => false,
		parity: { session: "work", folderMissing: true },
	},
	{
		id: "missing-folder-sheet",
		area: "A",
		title: "A session whose folder was deleted, selected: its transcript read-only, with Archive (nothing saved to restore)",
		open: async (page, look) => {
			await openFolderMissing(page, look);
			await page
				.locator(
					':is(.omp-sidebar-session-row, [data-device-session])[data-folder-missing]:has-text("Parity folder gone") button',
				)
				.first()
				.click();
			// The sheet's body holds the stored transcript (read with no omp); its footer the action.
			await page
				.locator("[data-missing-folder-sheet] .omp-transcript-row")
				.first()
				.waitFor({ state: "visible", timeout: 15_000 });
		},
		ready: "[data-missing-folder-archive]",
		settle: 800,
		when: () => false,
		parity: { session: "work", folderMissing: true, after: closeOverlay },
	},
	{
		id: "transcript-top",
		area: "A",
		title: "Transcript scrolled to its first turn",
		open: showTranscriptStart,
		ready: '.omp-transcript-scroll [data-index="0"]',
	},
	{
		id: "transcript-stress",
		area: "A",
		title: "Transcript at the stress turns: long URL, wide table, long code line, diff, mermaid, long tool paths",
		open: page => showTurn(page, "Show me everything that tends to overflow on a phone."),
		ready: '.omp-user-bubble:has-text("Show me everything that tends to overflow on a phone.")',
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
		title: "Model picker: each model its provider's mark and compact name, opened from the composer's model chip",
		open: page => page.locator("[data-model-chip]").first().click(),
		ready: "[data-model-option]",
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "composer-slash-menu",
		area: "A",
		title: "Slash command menu",
		open: async page => {
			const input = page.locator("[data-composer-input]");
			await input.fill("");
			await input.pressSequentially("/", { delay: 30 });
		},
		ready: '.omp-composer-anchor [role="listbox"]',
	},
	{
		id: "composer-at-menu",
		area: "A",
		title: "@ file menu",
		open: async page => {
			const input = page.locator("[data-composer-input]");
			await input.fill("");
			await input.pressSequentially("@", { delay: 30 });
		},
		ready: '.omp-composer-anchor [role="listbox"]',
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
			open: async (page, look) => {
				if (panel !== "diff") return ui(page, "setPanelTab", panel);
				await openPanelView(page, look, "diff");
				await page.locator("[data-scm-bar]:visible").first().waitFor({ timeout: 20_000 });
			},
			ready:
				panel === "diff" ? "[data-scm-bar]:visible" : "[data-sheet-panel], [data-panel-tabbar], .omp-panel-topbar",
			...(panel === "diff" ? { parity: { session: "work" as const, after: closePanelView } } : {}),
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
		open: async (page, look) => {
			await openPanelView(page, look, "files");
			await page.getByLabel(say(look, "filesPanel.search"), { exact: true }).first().fill("Sidebar.tsx");
			await page
				.getByRole("treeitem", { name: /Sidebar\.tsx/ })
				.first()
				.click();
		},
		ready: "[data-file-viewer-head]",
		parity: { session: "work", after: closePanelView },
		settle: 1200,
	},

	// ── Area B: Settings, centers, dialogs ────────────────────────────────────────────────────
	...SETTINGS_SECTIONS.filter(section => section !== "models").map(
		(section): Surface => ({
			id: `settings-${section}`,
			area: "B",
			title: `Settings › ${section}`,
			// General opens through real controls (the sidebar's Settings, then its section), so the parity sheet takes it.
			open: section === "general" ? openSettingsGeneral : page => openSettings(page, section),
			ready: "[data-settings-page]",
			settle: 900,
			...(section === "general" ? { parity: { session: "work" } } : {}),
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
	{
		id: "settings-model-role-picker",
		area: "B",
		title: "Settings › Model roles with the Default role's picker open: mark and compact name per model",
		open: async (page, look) => {
			await openSettingsModels(page, look);
			const trigger = page.locator("[data-settings-page] #model-role-default [aria-haspopup='listbox']");
			await trigger.waitFor({ state: "visible", timeout: 30_000 });
			await trigger.scrollIntoViewIfNeeded();
			await trigger.click();
		},
		ready: "[role='listbox'] [role='option']",
		settle: 600,
		// Parity only: the audits measure the model picker through the composer's chip above.
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "settings-reset-tickets",
		area: "B",
		title: "Settings › Models & accounts, the reset pass dialog of an account that holds two kinds of pass",
		open: async (page, look) => {
			await openSettingsModels(page, look);
			const ticket = page.locator("[data-settings-page] [data-reset-passes] button").first();
			await ticket.waitFor({ state: "visible", timeout: 30_000 });
			await ticket.scrollIntoViewIfNeeded();
			await ticket.click();
		},
		ready: "[role='dialog'] [data-reset-ticket]",
		settle: 600,
		// Parity only, and only over a host whose fake omp has such an account.
		when: () => false,
		parity: {
			session: "work",
			after: closeOverlay,
			available: () =>
				process.env.OMP_GUI_TEST_LOGIN === "1" &&
				process.env.OMP_GUI_TEST_MODELS === "1" &&
				process.env.OMP_GUI_TEST_RESET_TICKETS === "1",
		},
	},
	{
		id: "settings-computer-use",
		area: "B",
		title: "Settings › Agent behavior, scrolled to Computer use engine and the macOS permission rows under it",
		open: openSettingsComputerUse,
		ready: "[data-settings-page] [data-mac-permission]",
		settle: 900,
		// The rows read the computer's macOS permissions from main: the audits' harness page has no such computer.
		when: () => false,
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
		open: async page => {
			await openSettings(page, "connections");
			await page.locator("[data-settings-page] [data-web-push-state]").first().scrollIntoViewIfNeeded();
		},
		ready: "[data-settings-page] [data-web-push-state]",
		settle: 900,
	},
	...(["live", "definitions", "prs", "github"] as const).map(
		(tab): Surface => ({
			id: `agents-${tab}`,
			area: "B",
			title: `Agents › ${tab}`,
			// Live opens through the palette and its tab (real controls), so the parity sheet takes it.
			open: tab === "live" ? page => openPageTab(page, "agents", "live") : page => ui(page, "openAgents", tab),
			settle: 900,
			...(tab === "live" ? { parity: { session: "work" as const } } : {}),
		}),
	),
	{
		id: "stats",
		area: "B",
		title: "Insights › Stats (this session)",
		open: page => openPageTab(page, "stats", "session"),
		settle: 900,
		parity: { session: "work" },
	},
	{
		id: "stats-all",
		area: "B",
		title: "Insights › Stats (all sessions)",
		open: page => openPageTab(page, "stats", null),
		settle: 1200,
		parity: { session: "work" },
	},
	{
		id: "usage",
		area: "B",
		title: "Insights › Usage",
		open: page => openPageTab(page, "stats", "usage"),
		settle: 900,
		parity: { session: "work" },
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
			open: (page, look) =>
				dialog.id === "dialog-command-palette"
					? clickCommandPalette(page)
					: dialog.id === "dialog-model-setup"
						? openModelSetup(page, look)
						: ui(page, dialog.action, ...(dialog.args ?? [])),
			...(dialog.id === "dialog-command-palette"
				? { ready: "[role=dialog] [role=listbox]", parity: { session: "work" as const } }
				: dialog.id === "dialog-model-setup"
					? {
							// Ready at the research model selector beside "Find more evidence".
							ready: "[role=dialog] [data-model-setup-evidence] [aria-haspopup=listbox]",
							parity: { session: "work" as const, after: closeOverlay },
						}
					: {}),
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
		parity: { session: "work" },
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
		id: "sidebar-project-menu",
		area: "A",
		title: "A project header's action menu: its one Delete last",
		open: openProjectMenu,
		ready: "[role='menu'] [role='menuitem']",
		// The shown session's project, in this computer's list or the paired computer's section for the host: the parity
		// sheet's views all show a session of the host's project; the audits' harness page has no such session.
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "sidebar-project-delete",
		area: "A",
		title: "A project's Delete confirm: its opt-in box to also delete the saved sessions, off as it opens",
		open: async (page, look) => {
			await openProjectMenu(page, look);
			await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
		},
		ready: "[role='dialog']",
		when: () => false,
		parity: { session: "work", after: closeOverlay },
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
		id: "card-ask-pictures",
		area: "A",
		title: "Ask card of an ask form with pictures: the drafts side by side above the question, before anything is picked",
		// The host's fake omp asks it (e2e/fixture/rpc-ui.ts "fixture ask pictures"), as the bridge's ask form sends a
		// form of pictures; Escape answers it, which ends that turn.
		open: async page => {
			const tab = await shownTab(page);
			if (!tab) throw new Error("the view shows no session to ask in");
			await page.evaluate(
				tabId => window.omp.rpc.commandForTab(tabId, { type: "prompt", message: "fixture ask pictures" }),
				tab.tabId,
			);
		},
		ready: "[data-ask-context] [data-figure-row] figure:nth-child(3) img",
		when: () => false,
		parity: { session: "work", after: closeOverlay },
	},
	{
		id: "card-approval",
		area: "A",
		title: "Tool approval card with a long command, docked above the composer (an Autopilot run's card once its approver's 3 s have passed)",
		open: page =>
			request(page, {
				id: "audit-approval",
				method: "select",
				title: "Allow tool: bash\nbunx vitest run src/renderer/components/layout/sidebar src/renderer/components/layout/composer --repeat 10 --reporter=verbose",
				options: ["Approve", "Deny"],
			}),
		ready: ".omp-ask-dock [data-prompt-card]",
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
		when: webPage,
		open: page =>
			hostPrompt(page, {
				kind: "openPath",
				path: "/Users/dev/projects/ompdesk/src/renderer/components/layout/sidebar/Sidebar.tsx",
			}),
		ready: '[data-host-sheet="openPath"]',
	},
	{
		id: "host-browser-folder",
		area: "B",
		title: "Host sheet: the computer's folder browser",
		query: "&host=1",
		when: webPage,
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
		when: webPage,
		open: page =>
			hostPrompt(page, { kind: "browse", mode: "file", title: "Attach a file", defaultPath: "/Users/dev/projects" }),
		settle: 700,
	},
	{
		id: "host-editor",
		area: "B",
		title: "Host sheet: edit on the computer",
		query: "&host=1",
		when: webPage,
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
		when: webPage,
		open: page =>
			hostPrompt(page, { kind: "saveImage", name: "diagram.png", mime: "image/png", base64: "iVBORw0KGgo=" }),
	},
	{
		id: "host-models-config",
		area: "B",
		title: "Host sheet: the agent's models file",
		query: "&host=1",
		when: webPage,
		open: page => hostPrompt(page, { kind: "models" }),
		settle: 700,
	},
	{
		id: "host-quit",
		area: "B",
		title: "Host sheet: quit confirmation",
		query: "&host=1",
		when: webPage,
		open: page => hostPrompt(page, { kind: "quit" }),
	},
	{
		id: "host-update",
		area: "B",
		title: "Host sheet: update confirmation",
		query: "&host=1",
		when: webPage,
		open: page => hostPrompt(page, { kind: "update" }),
	},
	// No sheet for `prompt`: a browser that offers its own install prompt gets that prompt (install-ui.ts), the sheet
	// only lists the menu steps of one that does not. Those browsers are a phone's or a tablet's.
	...(["ios-share", "samsung-menu", "firefox-menu"] as const).map(
		(guidance): Surface => ({
			id: `host-install-${guidance}`,
			area: "B",
			title: `PWA install sheet (${guidance})`,
			query: "&host=1",
			when: touchLook,
			open: page => hostPrompt(page, { kind: "install", guidance }),
			ready: `[data-install-steps="${guidance}"]`,
		}),
	),
];

export function surfacesFor(filter: { area?: string; only?: RegExp }): Surface[] {
	return SURFACES.filter(
		surface => (!filter.area || surface.area === filter.area) && (!filter.only || filter.only.test(surface.id)),
	);
}

export { isPhone };
