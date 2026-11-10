/**
 * Frame strips of the app's UI motion, on the dev harness (the renderer in Chromium over the fixture transport,
 * `vite.harness.config.ts`). Registers no test unless `OMP_GUI_MOTION_SHOTS=<dir>` names where the strips go, so the
 * before and after of a motion change are the same command run into two folders:
 *
 *   OMP_GUI_MOTION_SHOTS=/tmp/motion-shots/before bun run locked -- bunx playwright test e2e/motion-captures.e2e.ts \
 *     --output /tmp/motion-captures-results
 *
 * How a step is captured. The page runs at one tenth of real speed: CDP `Animation.setPlaybackRate(0.1)` slows every
 * CSS animation, transition and Web Animation (view transitions included), and an init script dilates the page's own
 * clock by the same factor (`Date.now`, `performance.now`, `setTimeout`, `setInterval`), so a toast that lingers 200 ms
 * after its dismissal for the exit lingers 2 s beside an exit slowed to 2 s. Only requestAnimationFrame-driven motion
 * that reads the frame's own timestamp is left at full speed. The step's action fires, then eight shots of the step's
 * region are taken evenly across ten times the motion (350 ms by default: one shot every 437 ms, the first right after
 * the action) and one more once it has settled (the rest shot). Nine frames tile left to right into one strip.
 *
 * Output, per step `<id>`, viewport (`wide` 1440x900, `phone` 390x844 at 2x with touch) and theme:
 *   <dir>/<id>/<viewport>-<theme>.png           the strip, each frame scaled to at most 480 px wide
 *   <dir>/<id>/<viewport>-<theme>/frame-1..9.png  the frames at full size (9 is the rest shot), plus before.png
 *   <dir>/<id>/<viewport>-<theme>.json          what index.md is built from
 *   <dir>/index.md                              every step x viewport x theme: strip path or skip reason
 * `OMP_GUI_MOTION_VIDEO=1` also records each flow at real speed to <dir>/_video/<flow>-<viewport>-<theme>.webm.
 * `OMP_GUI_MOTION_ROOT=<checkout>` serves that checkout's renderer (default: this one; a pristine checkout gives a
 * before set while the working tree changes). `OMP_GUI_MOTION_TOKENS=<file.css>` puts that stylesheet after the app's
 * own, to try another set of motion tokens on the same flows.
 *
 * Surfaces are found by role, text and data attributes, never by an animation class, so the spec keeps working while
 * the motion beneath it changes. A surface the viewport does not have is skipped with its reason in the flow's
 * `skip` and in index.md.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	type Browser,
	type BrowserContext,
	type CDPSession,
	chromium,
	devices,
	type Page,
	test,
} from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { SummaryFacts } from "../src/main/session-summaries";

const SHOTS = process.env.OMP_GUI_MOTION_SHOTS;
const VIDEO = process.env.OMP_GUI_MOTION_VIDEO === "1";
const FFMPEG = process.env.OMP_GUI_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";

/** One tenth of real speed. */
const RATE = 0.1;
const SLOW = 1 / RATE;
const MOTION_FRAMES = 8;
const FRAME_MAX_WIDTH = 480;
/** Real milliseconds of motion a step is expected to hold; the capture window is `SLOW` times this. */
const DEFAULT_MOTION_MS = 350;
const SETTLE_MS = 700;

type Viewport = "wide" | "phone";
type Theme = "light" | "dark";
const VIEWPORTS: readonly Viewport[] = ["wide", "phone"];
const THEMES: readonly Theme[] = ["light", "dark"];

const SIZES: Record<Viewport, { width: number; height: number }> = {
	wide: { width: 1440, height: 900 },
	phone: { width: 390, height: 844 },
};

const CONTEXTS: Record<Viewport, Parameters<Browser["newContext"]>[0]> = {
	wide: { viewport: SIZES.wide },
	phone: {
		viewport: SIZES.phone,
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
		userAgent: devices["iPhone 15"].userAgent,
	},
};

/** The checkout whose renderer the harness serves (a pristine one for a before set); the spec itself runs from here. */
const ROOT = realpathSync(path.resolve(process.env.OMP_GUI_MOTION_ROOT ?? "."));
/** `OMP_GUI_MOTION_TOKENS=<css file>`: a stylesheet put after the app's own, to try other motion tokens on the same flows. */
const TOKENS = process.env.OMP_GUI_MOTION_TOKENS
	? readFileSync(path.resolve(process.env.OMP_GUI_MOTION_TOKENS), "utf8")
	: undefined;

interface Clip {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Ctx {
	page: Page;
	viewport: Viewport;
	/** What an earlier action of the flow left for a later one (a toast's id). */
	state: Record<string, unknown>;
}

interface Step {
	/** The output folder, and the row in index.md. */
	id: string;
	/** What the step puts on screen, for index.md. */
	what: string;
	/** Runs before the capture at full speed; the page then settles. */
	prepare?: (c: Ctx) => Promise<void>;
	/** The action whose motion is captured. */
	trigger: (c: Ctx) => Promise<void>;
	/** Undoes what the trigger holds (a pressed button) once the capture ends. */
	release?: (c: Ctx) => Promise<void>;
	/** The part of the page the frames show, measured after `prepare`; the whole page when absent. */
	region?: (c: Ctx) => Promise<Clip | undefined>;
	/** Real milliseconds of motion expected; the capture window is ten times as long. */
	motionMs?: number;
	settleMs?: number;
}

interface Flow {
	id: string;
	title: string;
	/** Extra harness query (`&board=busy`). */
	query?: string;
	/** Viewports without the surface, with why. */
	skip?: Partial<Record<Viewport, string>>;
	/** Runs once after boot, before the first step; the page then settles. */
	prepare?: (c: Ctx) => Promise<void>;
	steps: readonly Step[];
}

// ── page helpers ───────────────────────────────────────────────────────────────────────────────

/** Dilates the page's clock by `window.__motionScale(n)` (1 = real time); see the header. */
const CLOCK_SCRIPT = `(() => {
	const realDate = Date.now.bind(Date);
	const realPerf = performance.now.bind(performance);
	const realTimeout = window.setTimeout.bind(window);
	const realInterval = window.setInterval.bind(window);
	let scale = 1;
	let dateAt = realDate();
	let dateBase = dateAt;
	let perfAt = realPerf();
	let perfBase = perfAt;
	Date.now = () => Math.floor(dateBase + (realDate() - dateAt) / scale);
	performance.now = () => perfBase + (realPerf() - perfAt) / scale;
	const delayed = (delay) => (typeof delay === "number" ? delay * scale : delay);
	window.setTimeout = (fn, delay, ...args) => realTimeout(fn, delayed(delay), ...args);
	window.setInterval = (fn, delay, ...args) => realInterval(fn, delayed(delay), ...args);
	window.__motionScale = (next) => {
		dateBase = Date.now();
		perfBase = performance.now();
		dateAt = realDate();
		perfAt = realPerf();
		scale = next;
	};
})();`;

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

async function uiAction(page: Page, action: string, ...args: unknown[]): Promise<void> {
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

/** A push from main, as the transport delivers it (`window.__harness.emit`). */
async function emit(page: Page, channel: string, data: unknown): Promise<void> {
	await page.evaluate(
		({ channel, data }) => {
			if (!window.__harness) throw new Error("no harness");
			window.__harness.emit(channel, data);
		},
		{ channel, data },
	);
}

/** Frames of the running agent loop the transcript takes, as `rpc:events` carries them. */
async function deliver(page: Page, tabId: string, message: Record<string, unknown>): Promise<void> {
	await emit(page, "rpc:events", { tabId, payload: [{ type: "message_end", message }] });
}

const REPLY = "Running it again now. All 1200 repeats pass, same as before, so the fix holds.";

const assistantMessage = (blocks: unknown[]): Record<string, unknown> => ({
	role: "assistant",
	content: blocks,
	stopReason: "stop",
	model: "fixture",
	timestamp: Date.now(),
});

async function patchTabs(page: Page, patch: Record<string, Record<string, unknown>>): Promise<void> {
	await page.evaluate(patch => {
		const tabs = window.__stores?.tabs as unknown as {
			getState(): { tabs: { id: string }[] };
			setState(partial: unknown): void;
		};
		tabs.setState({ tabs: tabs.getState().tabs.map(tab => ({ ...tab, ...patch[tab.id] })) });
	}, patch);
}

/** Tabs' run facts as the pool reports them: the sidebar's rows read them from the harness's summaries. */
async function setSummaries(page: Page, change: Record<string, Partial<SummaryFacts>>): Promise<void> {
	await page.evaluate(change => {
		const summaries = window.__harness?.summaries;
		if (!summaries) throw new Error("no harness summaries");
		for (const [tabId, facts] of Object.entries(change)) summaries.tab(tabId, facts);
	}, change);
}

/**
 * A session appearing in a computer's list (`harness.sessions`), as main pushes `sessions:changed`; `device` names a
 * paired host. Resolves once its row is on screen: the list reads after a debounce, which the slowed clock stretches
 * past a capture's window, and a step's motion starts on that commit.
 */
async function addSession(page: Page, title: string, device?: string): Promise<void> {
	await page.evaluate(
		({ title, device }) => {
			const harness = window.__harness;
			if (!harness) throw new Error("no harness");
			const id = `sess-new-${harness.sessions.length + 1}`;
			const now = new Date().toISOString();
			harness.sessions.unshift({
				path: `/Users/dev/.omp/agent/sessions/-Users-dev-projects-ompdesk/${id}.jsonl`,
				id,
				title,
				cwd: "/Users/dev/projects/ompdesk",
				created: now,
				modified: now,
				messageCount: 2,
				size: 4096,
				status: "complete",
				firstMessage: title,
			});
			harness.emit("sessions:changed", device ? { device } : {});
		},
		{ title, device },
	);
	await listScope(page, device)
		.getByText(title, { exact: true })
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
}

async function openDrawer(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Open menu" }).click();
	await page.locator("[data-drawer]").waitFor({ state: "visible" });
}

const sessionRow = (page: Page, title: string) =>
	page.locator(".omp-list-row:has([data-sidebar-row-menu])").filter({ hasText: title }).first();

/**
 * Opens a row's menu in this computer's list or a paired host's section (`device`), ready for a step to pick an item
 * (the list keeps a project's rows in their own order, so a reorder is the person's Move up or Move down).
 */
async function openListRowMenu(c: Ctx, title: string, device?: string): Promise<void> {
	const row = listScope(c.page, device).locator(".omp-list-row").filter({ hasText: title }).first();
	if (c.viewport === "wide") await row.hover();
	const more = row.locator("[data-sidebar-row-menu]");
	if ((await more.count()) > 0) await more.first().click();
	else await row.click({ button: "right" });
	await c.page.getByRole("menu").waitFor({ state: "visible" });
}

/** Where a computer's rows are: a paired host's section, or the whole page for this computer (it lists first). */
const listScope = (page: Page, device?: string) =>
	device ? page.locator(`[data-sidebar-device="${device}"]`).first() : page.locator("body");

/** The harness's paired host (`REMOTE_STATE.hosts[0]`, online) and its first session row. */
const hostSection = (page: Page) => page.locator('[data-sidebar-device="host-1"]').first();
const hostRow = (page: Page) => hostSection(page).locator("[data-device-session]").first();

/** A host row's menu: its ⋯ where the row has one, else the row's context menu. */
async function openHostRowMenu(c: Ctx): Promise<void> {
	const row = hostRow(c.page);
	if (c.viewport === "wide") await row.hover();
	const more = row.locator("[data-sidebar-row-menu]");
	if ((await more.count()) > 0) await more.first().click();
	else await row.click({ button: "right" });
	await c.page.getByRole("menu").waitFor({ state: "visible" });
}

// ── regions ────────────────────────────────────────────────────────────────────────────────────

const viewportOf = (page: Page): { width: number; height: number } => {
	const size = page.viewportSize();
	if (!size) throw new Error("no viewport");
	return size;
};

function clamp(page: Page, clip: Clip): Clip {
	const { width, height } = viewportOf(page);
	const x = Math.max(0, Math.floor(clip.x));
	const y = Math.max(0, Math.floor(clip.y));
	return {
		x,
		y,
		width: Math.max(1, Math.min(width - x, Math.ceil(clip.width))),
		height: Math.max(1, Math.min(height - y, Math.ceil(clip.height))),
	};
}

/** The middle of the window on a computer (backdrop and dialog), the whole screen on a phone. */
const centre = async ({ page, viewport }: Ctx): Promise<Clip | undefined> => {
	if (viewport === "phone") return undefined;
	const { width, height } = viewportOf(page);
	return { x: (width - 800) / 2, y: (height - 560) / 2, width: 800, height: 560 };
};

/** The element's box, grown by `pad`. */
const around =
	(selector: string, pad = 0) =>
	async ({ page }: Ctx): Promise<Clip | undefined> => {
		const box = await page.locator(selector).first().boundingBox();
		if (!box) throw new Error(`${selector} has no box`);
		return clamp(page, { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad });
	};

/** The sidebar's top: the list on a computer, the whole screen with its drawer open on a phone. */
const sidebarTop = async ({ viewport }: Ctx): Promise<Clip | undefined> =>
	viewport === "phone" ? undefined : { x: 0, y: 0, width: 260, height: 480 };

/** The paired host's section and room beside it for its menu; the whole screen on a phone. */
const hostRegion = async ({ page, viewport }: Ctx): Promise<Clip | undefined> => {
	if (viewport === "phone") return undefined;
	const box = await hostSection(page).boundingBox();
	if (!box) throw new Error("no host section");
	return clamp(page, { x: 0, y: box.y - 8, width: 520, height: 420 });
};

/** The composer and what rises above it (popovers, completions). */
const composerArea = async ({ page, viewport }: Ctx): Promise<Clip | undefined> => {
	if (viewport === "phone") return { x: 0, y: 344, width: 390, height: 500 };
	const box = await page.locator(".omp-composer-box").first().boundingBox();
	if (!box) throw new Error("no composer");
	return clamp(page, { x: box.x - 16, y: box.y - 420, width: box.width + 32, height: box.height + 440 });
};

/** The conversation column on a computer, the whole screen on a phone. */
const conversation = async ({ viewport }: Ctx): Promise<Clip | undefined> =>
	viewport === "phone" ? undefined : { x: 250, y: 60, width: 870, height: 840 };

/** Where the toast stack sits: bottom right on a computer, along the top on a phone. */
const toastCorner = async ({ page, viewport }: Ctx): Promise<Clip | undefined> => {
	const { width, height } = viewportOf(page);
	return viewport === "phone"
		? { x: 0, y: 0, width, height: 220 }
		: { x: width - 420, y: height - 220, width: 420, height: 220 };
};

// ── flows ──────────────────────────────────────────────────────────────────────────────────────

const workCardHeader = (page: Page) => page.getByRole("button", { name: /^Steps:/ });
/** A thinking block's own header (its name reads "Thought…", "Reasoning…" or the live state, by display preference). */
const thinkingHeader = (page: Page) => page.locator(".omp-thinking-block button[aria-expanded]").first();
/** The title bar's Session actions (every sidebar row has a hidden one of the same name). */
const HEADER_ACTIONS = 'button[aria-label="Session actions"]:not([data-sidebar-row-menu])';

const toastPush = (page: Page): Promise<number> =>
	page.evaluate(() => {
		const toast = window.__stores?.toast?.getState() as { push(input: unknown): number } | undefined;
		if (!toast) throw new Error("no toast store");
		return toast.push({
			variant: "success",
			title: "Saved",
			message: "Copied the link to the clipboard",
			durationMs: Number.POSITIVE_INFINITY,
		});
	});

const FLOWS: readonly Flow[] = [
	{
		id: "dialog",
		title: "a dialog opens and closes",
		steps: [
			{
				id: "dialog-open",
				what: "Rename dialog: backdrop and panel arriving",
				region: centre,
				// The title button renames inline; the dialog is what the row menu's Rename and the palette open.
				trigger: ({ page }) => uiAction(page, "openRenameDialog"),
			},
			{
				id: "dialog-close",
				what: "Rename dialog leaving on Escape",
				region: centre,
				trigger: ({ page }) => page.keyboard.press("Escape"),
			},
		],
	},
	{
		id: "popover",
		title: "the model picker opens and closes",
		steps: [
			{
				id: "popover-open",
				what: "Model picker (a popover on a computer, a sheet on a phone) arriving",
				region: composerArea,
				trigger: ({ page }) => page.locator("[data-model-chip]").first().click(),
			},
			{
				id: "popover-close",
				what: "Model picker leaving on Escape",
				region: composerArea,
				trigger: ({ page }) => page.keyboard.press("Escape"),
			},
		],
	},
	{
		id: "menu",
		title: "a session row's menu opens and closes",
		prepare: async ({ page, viewport }) => {
			if (viewport === "phone") await openDrawer(page);
		},
		steps: [
			{
				id: "menu-open",
				what: "A session row's ⋯ menu arriving",
				region: sidebarTop,
				prepare: async ({ page, viewport }) => {
					if (viewport === "wide") await sessionRow(page, "Add dark mode").hover();
				},
				trigger: ({ page }) => sessionRow(page, "Add dark mode").locator("[data-sidebar-row-menu]").first().click(),
			},
			{
				id: "menu-close",
				what: "The row's menu leaving on Escape",
				region: sidebarTop,
				trigger: ({ page }) => page.keyboard.press("Escape"),
			},
		],
	},
	{
		id: "completion",
		title: "the composer's slash and mention completions open and close",
		steps: [
			{
				id: "completion-slash-open",
				what: "Slash command list rising above the composer",
				region: composerArea,
				prepare: ({ page }) => page.locator("[data-composer-input]").click(),
				trigger: ({ page }) => page.keyboard.type("/"),
			},
			{
				id: "completion-slash-close",
				what: "Slash command list leaving on Escape",
				region: composerArea,
				trigger: ({ page }) => page.keyboard.press("Escape"),
			},
			{
				id: "completion-mention-open",
				what: "@ file list rising above the composer",
				region: composerArea,
				prepare: ({ page }) => page.locator("[data-composer-input]").fill(""),
				trigger: ({ page }) => page.keyboard.type("@"),
			},
			{
				id: "completion-mention-close",
				what: "@ file list leaving on Escape",
				region: composerArea,
				trigger: ({ page }) => page.keyboard.press("Escape"),
			},
		],
	},
	{
		id: "toast",
		title: "a toast comes in and goes out",
		steps: [
			{
				id: "toast-in",
				what: "A success toast arriving",
				region: toastCorner,
				trigger: async c => {
					c.state.toast = await toastPush(c.page);
				},
			},
			{
				id: "toast-out",
				what: "The toast leaving on its close button",
				region: toastCorner,
				trigger: ({ page }) => page.getByRole("status").getByRole("button", { name: "Close" }).click(),
			},
		],
	},
	{
		id: "work-card",
		title: "a work card expands and collapses",
		steps: [
			{
				id: "work-card-expand",
				what: "Work complete card opening its steps",
				region: conversation,
				trigger: ({ page }) => workCardHeader(page).first().click(),
			},
			{
				id: "work-card-collapse",
				what: "Work complete card closing its steps",
				region: conversation,
				trigger: ({ page }) => workCardHeader(page).first().click(),
			},
		],
	},
	{
		id: "tool-card",
		title: "a tool card expands and collapses",
		prepare: async ({ page }) => {
			await workCardHeader(page).first().click();
			await page.getByRole("button", { name: /^Run command/ }).waitFor({ state: "visible" });
		},
		steps: [
			{
				id: "tool-card-expand",
				what: "Run command card showing its output",
				region: conversation,
				trigger: ({ page }) => page.getByRole("button", { name: /^Run command/ }).click(),
			},
			{
				id: "tool-card-collapse",
				what: "Run command card hiding its output",
				region: conversation,
				trigger: ({ page }) => page.getByRole("button", { name: /^Run command/ }).click(),
			},
		],
	},
	{
		id: "thinking",
		title: "a thinking block expands and collapses",
		prepare: async ({ page }) => {
			await deliver(
				page,
				"tab-1",
				assistantMessage([
					{
						type: "thinking",
						thinking:
							"The user wants the suite run again.\n\nI should run it with repeat 10 and compare against the earlier pass before replying.",
					},
					{ type: "text", text: REPLY },
				]),
			);
			await workCardHeader(page).last().click();
			await thinkingHeader(page).waitFor({ state: "visible" });
		},
		steps: [
			{
				id: "thinking-expand",
				what: "Thought block showing its text",
				region: conversation,
				trigger: ({ page }) => thinkingHeader(page).click(),
			},
			{
				id: "thinking-collapse",
				what: "Thought block folding away",
				region: conversation,
				trigger: ({ page }) => thinkingHeader(page).click(),
			},
		],
	},
	{
		id: "message",
		title: "messages arrive in the transcript",
		steps: [
			{
				id: "message-send",
				what: "The sent prompt joining the transcript",
				region: conversation,
				prepare: async ({ page }) => {
					await page.locator("[data-composer-input]").fill("Run the suite again please");
				},
				trigger: ({ page }) => page.keyboard.press("Enter"),
			},
			{
				id: "message-reply",
				what: "The agent's reply joining the transcript",
				region: conversation,
				trigger: ({ page }) => deliver(page, "tab-1", assistantMessage([{ type: "text", text: REPLY }])),
			},
		],
	},
	{
		id: "sidebar-rows",
		title: "sidebar rows are added, selected and reordered",
		prepare: async ({ page, viewport }) => {
			if (viewport === "phone") await openDrawer(page);
		},
		steps: [
			{
				id: "sidebar-row-added",
				what: "A new session row joining the project's list",
				region: sidebarTop,
				prepare: ({ page }) => addSession(page, "Older idea"),
				trigger: ({ page }) => addSession(page, "Brand new session"),
			},
			{
				id: "sidebar-row-selected",
				what: "Another row taking the selection",
				region: sidebarTop,
				trigger: ({ page }) => sessionRow(page, "Add dark mode").click(),
			},
			{
				id: "sidebar-row-reordered",
				what: "A row moved down one place from its menu (both rows glide)",
				region: sidebarTop,
				prepare: async c => {
					if (c.viewport === "phone") await openDrawer(c.page);
					await openListRowMenu(c, "Brand new session");
				},
				trigger: ({ page }) => page.getByRole("menuitem", { name: "Move down" }).click(),
			},
		],
	},
	{
		// The owner's rule: every motion looks the same in a paired computer's section as in this computer's.
		id: "host-section",
		title: "a paired computer's section: row press, row menu, fold",
		prepare: async ({ page, viewport }) => {
			if (viewport === "phone") await openDrawer(page);
			await hostSection(page).scrollIntoViewIfNeeded();
		},
		steps: [
			{
				id: "host-row-added",
				what: "A new session row joining the paired host's list",
				region: hostRegion,
				prepare: ({ page }) => addSession(page, "Older idea", "host-1"),
				trigger: ({ page }) => addSession(page, "Brand new session", "host-1"),
			},
			{
				id: "host-row-reordered",
				what: "A host row moved down one place from its menu (both rows glide)",
				region: hostRegion,
				prepare: c => openListRowMenu(c, "Brand new session", "host-1"),
				trigger: ({ page }) => page.getByRole("menuitem", { name: "Move down" }).click(),
			},
			{
				id: "host-row-menu-open",
				what: "A paired host's session row: its menu arriving",
				region: hostRegion,
				trigger: c => openHostRowMenu(c),
			},
			{
				id: "host-row-menu-close",
				what: "The host row's menu leaving on Escape",
				region: hostRegion,
				trigger: ({ page }) => page.keyboard.press("Escape"),
			},
			{
				id: "host-row-press",
				what: "A paired host's session row held down",
				region: hostRegion,
				trigger: async ({ page }) => {
					const box = await hostRow(page).boundingBox();
					if (!box) throw new Error("no host row");
					await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
					await page.mouse.down();
				},
				release: ({ page }) => page.mouse.up(),
			},
			{
				id: "host-fold",
				what: "The paired host's section folding to its header",
				region: hostRegion,
				trigger: ({ page }) => hostSection(page).locator("[aria-expanded]").first().click(),
			},
			{
				id: "host-unfold",
				what: "The paired host's section opening again",
				region: hostRegion,
				trigger: ({ page }) => hostSection(page).locator("[aria-expanded]").first().click(),
			},
		],
	},
	{
		id: "side-panel",
		title: "the side panel opens, switches view and closes",
		steps: [
			{
				id: "panel-open",
				what: "Side panel (a column on a computer, a sheet on a phone) arriving on Changes",
				trigger: ({ page }) => page.getByRole("button", { name: "Side panel" }).click(),
			},
			{
				id: "panel-switch",
				what: "Panel switching from Changes to Files",
				trigger: ({ page }) => page.getByRole("button", { name: "Files", exact: true }).click(),
			},
			{
				id: "panel-close",
				what: "Side panel leaving",
				trigger: ({ page }) => page.getByRole("button", { name: "Close side panel" }).click(),
			},
		],
	},
	{
		id: "page-switch",
		title: "Settings opens, changes section and closes",
		steps: [
			{
				id: "settings-open",
				what: "Settings replacing the session",
				settleMs: 1200,
				// A phone's Settings button lives in the drawer; the store call is what that button makes.
				trigger: ({ page, viewport }) =>
					viewport === "phone"
						? uiAction(page, "openSettings")
						: page
								.getByRole("button", { name: /^Settings/ })
								.first()
								.click(),
			},
			{
				id: "settings-section",
				what: "Settings moving to Appearance",
				settleMs: 1200,
				trigger: ({ page }) => page.locator('[data-settings-section="appearance"]').click(),
			},
			{
				id: "settings-close",
				what: "Settings handing back to the session",
				settleMs: 1200,
				trigger: ({ page }) => page.getByRole("button", { name: "Back to session" }).click(),
			},
		],
	},
	{
		id: "turn-finish",
		title: "a running turn finishes",
		prepare: async ({ page, viewport }) => {
			// The rows read the summaries; the header's mark and the tab strip read the window's own tabs.
			await setSummaries(page, { "tab-1": { status: "running" }, "tab-2": { status: "running" } });
			await patchTabs(page, { "tab-1": { status: "running" }, "tab-2": { status: "running" } });
			await page.evaluate(() => window.__stores?.session?.setState({ isStreaming: true }));
			if (viewport === "phone") await openDrawer(page);
		},
		steps: [
			{
				id: "turn-finish",
				what: "Running marks becoming done marks on the rows and the header",
				region: async ({ viewport }) => (viewport === "wide" ? { x: 0, y: 0, width: 720, height: 420 } : undefined),
				trigger: async ({ page }) => {
					await setSummaries(page, { "tab-1": { status: "ready" }, "tab-2": { status: "ready" } });
					await patchTabs(page, { "tab-1": { status: "ready" }, "tab-2": { status: "ready", unreadDone: true } });
					await page.evaluate(() => window.__stores?.session?.setState({ isStreaming: false }));
				},
			},
		],
	},
	{
		id: "button-press",
		title: "a button is pressed and held",
		steps: [
			{
				id: "button-press-primary",
				what: "Rename dialog's Save while the pointer is held down on it",
				region: async c => (await around('[role="dialog"]', 24)(c)) ?? undefined,
				prepare: async ({ page }) => {
					await uiAction(page, "openRenameDialog");
					const save = page.getByRole("dialog").getByRole("button", { name: "Save" });
					await save.waitFor({ state: "visible" });
					await page.waitForTimeout(700);
					await save.hover();
				},
				trigger: ({ page }) => page.mouse.down(),
				release: async ({ page }) => {
					await page.mouse.move(2, 2);
					await page.mouse.up();
					await page.keyboard.press("Escape");
				},
			},
			{
				id: "button-press-quiet",
				what: "Header's Session actions while the pointer is held down on it",
				region: around(HEADER_ACTIONS, 60),
				prepare: ({ page }) => page.locator(HEADER_ACTIONS).first().hover(),
				trigger: ({ page }) => page.mouse.down(),
				release: async ({ page }) => {
					await page.mouse.move(2, 2);
					await page.mouse.up();
				},
			},
		],
	},
	{
		id: "bottom-sheet",
		title: "a bottom sheet opens and closes",
		skip: { wide: "a computer shows Run settings as a popover: popover-open covers the same layer" },
		steps: [
			{
				id: "sheet-open",
				what: "Run settings sheet rising from the bottom edge",
				trigger: ({ page }) => page.locator("[data-run-settings-trigger]").first().click(),
			},
			{
				id: "sheet-close",
				what: "Run settings sheet leaving on Escape",
				trigger: ({ page }) => page.keyboard.press("Escape"),
			},
		],
	},
	{
		id: "drawer",
		title: "the phone's sidebar drawer opens and closes",
		skip: { wide: "a computer docks the sidebar: see sidebar-toggle" },
		steps: [
			{
				id: "drawer-open",
				what: "Drawer sliding in over the session",
				trigger: ({ page }) => page.getByRole("button", { name: "Open menu" }).click(),
			},
			{
				id: "drawer-close",
				what: "Drawer leaving on Escape",
				trigger: ({ page }) => page.keyboard.press("Escape"),
			},
		],
	},
	{
		id: "sidebar-toggle",
		title: "the docked sidebar hides and shows",
		skip: { phone: "a phone has no docked sidebar: see drawer" },
		steps: [
			{
				id: "sidebar-hide",
				what: "Docked sidebar folding away",
				trigger: ({ page }) => page.getByRole("button", { name: "Hide sidebar" }).click(),
			},
			{
				id: "sidebar-show",
				what: "Docked sidebar coming back",
				trigger: ({ page }) => page.getByRole("button", { name: "Toggle sidebar" }).click(),
			},
		],
	},
	{
		id: "work-strip",
		title: "the work strip expands and collapses",
		query: "&board=busy",
		prepare: async ({ page, viewport }) => {
			const chip = page.locator("[data-work-chip]").first();
			// A computer wide enough docks the board beside the transcript; the side panel narrows the pane to the strip.
			if (viewport === "wide" && !(await chip.isVisible().catch(() => false)))
				await page.getByRole("button", { name: "Side panel" }).click();
			await chip.waitFor({ state: "visible", timeout: 20_000 });
		},
		steps: [
			{
				id: "strip-expand",
				what: "Work strip opening its panel under the header",
				trigger: ({ page }) => page.locator("[data-work-chip]").first().click(),
			},
			{
				id: "strip-collapse",
				what: "Work strip closing its panel",
				trigger: ({ page }) => page.locator("[data-work-chip]").first().click(),
			},
		],
	},
];

// ── capture ────────────────────────────────────────────────────────────────────────────────────

const sha = async (file: string): Promise<string> =>
	createHash("sha1")
		.update(await fs.readFile(file))
		.digest("hex");

interface Meta {
	flow: string;
	step: string;
	viewport: Viewport;
	theme: Theme;
	what: string;
	status: "strip" | "skipped" | "failed";
	/** Why the step has no strip. */
	reason?: string;
	/** The strip, relative to the output folder. */
	strip?: string;
	/** What the frames show on their own: how many differ, and whether the step changed anything. */
	summary?: string;
	/** When each shot was taken, in real milliseconds after the action returned. */
	shotAt?: number[];
}

const metaFile = (dir: string, step: string, viewport: Viewport, theme: Theme) =>
	path.join(dir, step, `${viewport}-${theme}.json`);

async function writeMeta(dir: string, meta: Meta): Promise<void> {
	await fs.mkdir(path.join(dir, meta.step), { recursive: true });
	await fs.writeFile(metaFile(dir, meta.step, meta.viewport, meta.theme), `${JSON.stringify(meta, null, "\t")}\n`);
}

/** Frames 1..8 against each other and against the shot before the action, in words. */
function describeFrames(hashes: readonly string[], before: string): string {
	const motion = hashes.slice(0, MOTION_FRAMES);
	const distinct = new Set(motion).size;
	const rest = hashes[MOTION_FRAMES];
	if (distinct === 1) {
		if (motion[0] === before && rest === before)
			return "no visible change (the action did nothing, or only before the shot)";
		if (motion[0] === rest) return "no motion: the change was complete before the first frame";
		return "no motion between frames 1 and 8: the change landed after them";
	}
	return `${distinct} distinct frames of ${MOTION_FRAMES}${rest === motion[MOTION_FRAMES - 1] ? "" : "; the rest shot differs from frame 8"}`;
}

const execFileAsync = promisify(execFile);

async function strip(framesDir: string, out: string): Promise<void> {
	await execFileAsync(FFMPEG, [
		"-y",
		"-loglevel",
		"error",
		"-framerate",
		"1",
		"-i",
		path.join(framesDir, "frame-%d.png"),
		"-filter_complex",
		`scale='min(${FRAME_MAX_WIDTH},iw)':-2,tile=${MOTION_FRAMES + 1}x1`,
		"-frames:v",
		"1",
		out,
	]);
}

declare global {
	interface Window {
		/** Set by CLOCK_SCRIPT: runs the page's own clock at 1/n of real time. */
		__motionScale?(n: number): void;
	}
}

async function setSpeed(page: Page, cdp: CDPSession, slow: boolean): Promise<void> {
	await cdp.send("Animation.setPlaybackRate", { playbackRate: slow ? RATE : 1 });
	await page.evaluate(scale => window.__motionScale?.(scale), slow ? SLOW : 1);
}

/** Run the step's action at one tenth of speed and write its frames, strip and meta. */
async function capture(c: Ctx, cdp: CDPSession, step: Step, dir: string, theme: Theme): Promise<Meta> {
	const { page, viewport } = c;
	await step.prepare?.(c);
	await page.waitForTimeout(step.settleMs ?? SETTLE_MS);
	const clip = await step.region?.(c);
	const framesDir = path.join(dir, step.id, `${viewport}-${theme}`);
	await fs.rm(framesDir, { recursive: true, force: true });
	await fs.mkdir(framesDir, { recursive: true });
	const shoot = (name: string) =>
		page.screenshot({ path: path.join(framesDir, `${name}.png`), ...(clip ? { clip } : {}) });
	await shoot("before");

	const windowMs = (step.motionMs ?? DEFAULT_MOTION_MS) * SLOW;
	const interval = windowMs / MOTION_FRAMES;
	await setSpeed(page, cdp, true);
	const shotAt: number[] = [];
	try {
		await step.trigger(c);
		const start = Date.now();
		for (let frame = 0; frame < MOTION_FRAMES; frame++) {
			const wait = start + frame * interval - Date.now();
			if (wait > 0) await page.waitForTimeout(wait);
			await shoot(`frame-${frame + 1}`);
			shotAt.push(Date.now() - start);
		}
		const wait = start + windowMs + SETTLE_MS - Date.now();
		if (wait > 0) await page.waitForTimeout(wait);
	} finally {
		await setSpeed(page, cdp, false);
	}
	await step.release?.(c);
	await page.waitForTimeout(SETTLE_MS);
	// The rest shot is taken at full speed once nothing is left to move.
	await shoot(`frame-${MOTION_FRAMES + 1}`);

	const hashes = await Promise.all(
		Array.from({ length: MOTION_FRAMES + 1 }, (_, index) => sha(path.join(framesDir, `frame-${index + 1}.png`))),
	);
	const out = metaFile(dir, step.id, viewport, theme).replace(/\.json$/, ".png");
	await strip(framesDir, out);
	return {
		flow: "",
		step: step.id,
		viewport,
		theme,
		what: step.what,
		status: "strip",
		strip: path.relative(dir, out),
		summary: describeFrames(hashes, await sha(path.join(framesDir, "before.png"))),
		shotAt,
	};
}

// ── index.md ───────────────────────────────────────────────────────────────────────────────────

async function writeIndex(dir: string): Promise<void> {
	const lines = [
		"# Motion captures",
		"",
		"Each strip holds nine frames: 1-8 across ten times the motion (the page at one tenth of speed), 9 the rest shot.",
		"",
		"| flow | step | viewport | theme | strip | what it shows | measured |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const flow of FLOWS)
		for (const step of flow.steps)
			for (const viewport of VIEWPORTS)
				for (const theme of THEMES) {
					const meta: Meta | undefined = await fs
						.readFile(metaFile(dir, step.id, viewport, theme), "utf8")
						.then(text => JSON.parse(text) as Meta)
						.catch(() => undefined);
					const result =
						meta === undefined
							? "not run"
							: meta.status === "strip"
								? `[strip](${meta.strip})`
								: `${meta.status}: ${meta.reason ?? ""}`;
					lines.push(
						`| ${flow.id} | ${step.id} | ${viewport} | ${theme} | ${result} | ${step.what} | ${meta?.summary ?? ""} |`,
					);
				}
	const tmp = path.join(dir, `.index-${process.pid}.md`);
	await fs.writeFile(tmp, `${lines.join("\n")}\n`);
	await fs.rename(tmp, path.join(dir, "index.md"));
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────────

if (SHOTS) {
	const dir = path.resolve(SHOTS);
	let server: ViteDevServer | undefined;
	let origin = "";
	let browser: Browser | undefined;

	test.beforeAll(async () => {
		const port = await freePort();
		server = await createServer({
			configFile: path.join(ROOT, "vite.harness.config.ts"),
			// A baseline checkout's node_modules is a link into this one: its real paths must be servable.
			server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [ROOT, path.resolve(".")] } },
			logLevel: "error",
		});
		await server.listen();
		origin = `http://127.0.0.1:${port}`;
		browser = await chromium.launch();
		await fs.mkdir(dir, { recursive: true });
	});

	test.afterAll(async () => {
		await browser?.close();
		await server?.close();
	});

	async function boot(
		flow: Flow,
		viewport: Viewport,
		theme: Theme,
		video?: string,
	): Promise<{ context: BrowserContext; ctx: Ctx }> {
		if (!browser) throw new Error("no browser");
		const context = await browser.newContext({
			...CONTEXTS[viewport],
			reducedMotion: "no-preference",
			colorScheme: theme,
			...(video ? { recordVideo: { dir: video, size: SIZES[viewport] } } : {}),
		});
		await context.addInitScript(CLOCK_SCRIPT);
		const page = await context.newPage();
		await page.goto(`${origin}/harness.html?theme=${theme}&lang=en${flow.query ?? ""}`);
		await page.locator("[data-titlebar-session-name]").waitFor({ state: "visible", timeout: 45_000 });
		await page.waitForFunction(() => window.__stores?.subagents !== undefined, undefined, { timeout: 45_000 });
		// The token set goes in once the app's own stylesheets are in: an init-script <style> was dropped by the parser.
		// Its `:root:root` outranks the app's `:root` tokens wherever a later chunk's stylesheet lands.
		if (TOKENS !== undefined) {
			await page.addStyleTag({ content: TOKENS });
			const med = await page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue("--sc-duration-med"),
			);
			if (!TOKENS.includes(`--sc-duration-med: ${med.trim()}`))
				throw new Error(`token set not applied (med ${med})`);
		}
		const ctx: Ctx = { page, viewport, state: {} };
		await flow.prepare?.(ctx);
		return { context, ctx };
	}

	/** The flow once more at real speed, filmed. */
	async function film(flow: Flow, viewport: Viewport, theme: Theme): Promise<void> {
		const tmp = path.join(dir, "_video", `.${flow.id}-${viewport}-${theme}`);
		const { context, ctx } = await boot(flow, viewport, theme, tmp);
		const video = ctx.page.video();
		for (const step of flow.steps) {
			await step.prepare?.(ctx);
			await ctx.page.waitForTimeout(step.settleMs ?? SETTLE_MS);
			await step.trigger(ctx);
			await ctx.page.waitForTimeout((step.motionMs ?? DEFAULT_MOTION_MS) + 500);
			await step.release?.(ctx);
		}
		await context.close();
		await video?.saveAs(path.join(dir, "_video", `${flow.id}-${viewport}-${theme}.webm`));
		await fs.rm(tmp, { recursive: true, force: true });
	}

	for (const flow of FLOWS)
		for (const viewport of VIEWPORTS)
			for (const theme of THEMES)
				test(`${flow.title} (${viewport} ${theme})`, async () => {
					const reason = flow.skip?.[viewport];
					if (reason !== undefined) {
						for (const step of flow.steps)
							await writeMeta(dir, {
								flow: flow.id,
								step: step.id,
								viewport,
								theme,
								what: step.what,
								status: "skipped",
								reason,
							});
						await writeIndex(dir);
						test.skip(true, reason);
						return;
					}
					test.setTimeout(240_000);
					const { context, ctx } = await boot(flow, viewport, theme);
					const cdp = await context.newCDPSession(ctx.page);
					await cdp.send("Animation.enable");
					let current = flow.steps[0]?.id ?? flow.id;
					try {
						for (const step of flow.steps) {
							current = step.id;
							const meta = await capture(ctx, cdp, step, dir, theme);
							await writeMeta(dir, { ...meta, flow: flow.id });
						}
					} catch (error) {
						const step = flow.steps.find(entry => entry.id === current);
						await writeMeta(dir, {
							flow: flow.id,
							step: current,
							viewport,
							theme,
							what: step?.what ?? "",
							status: "failed",
							reason: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
						});
						throw error;
					} finally {
						await context.close();
						await writeIndex(dir);
					}
					if (VIDEO) await film(flow, viewport, theme);
				});
}
