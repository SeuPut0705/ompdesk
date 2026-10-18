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

const isPhone = (look: Look): boolean => look.width < 600;
/** A portrait tablet at least 800 px wide docks the session list; a phone and the narrower tablet use the drawer. */
const sidebarDocked = (look: Look): boolean => look.width >= 800;

async function openDrawer(page: Page, look: Look): Promise<void> {
	if (sidebarDocked(look)) return;
	await page.locator("button:visible:has(svg.lucide-menu)").first().click();
	await page.locator("[data-drawer]").waitFor({ state: "visible", timeout: 10_000 });
}

async function openSettings(page: Page, section: string): Promise<void> {
	await ui(page, "openSettings", section);
	const nav = page.locator(`[data-settings-section="${section}"]`);
	// A phone lists the sections first and pushes the chosen one; a tablet already shows it.
	if (await nav.isVisible().catch(() => false)) await nav.click();
}

/** Every Settings section of `SETTINGS_NAV` (settings-catalog.ts). */
export const SETTINGS_SECTIONS = [
	"general",
	"appearance",
	"keyboard",
	"models",
	"agent",
	"tools",
	"permissions",
	"workspace",
	"schedules",
	"connections",
	"updates",
	"advanced",
] as const;

const PANELS = ["terminal", "diff", "preview", "files", "jobs", "plan", "logs", "queue", "tree", "memory"] as const;

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
	},
	{
		id: "sidebar",
		area: "A",
		title: "Session list: the drawer on a phone, docked beside the page from 800 px",
		open: openDrawer,
		ready: "[data-tour='sessions'], [data-drawer]",
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
	...PANELS.map(
		(panel): Surface => ({
			id: `panel-${panel}`,
			area: "A",
			title: `Side panel › ${panel}`,
			open: async page => {
				await ui(page, "setPanelTab", panel);
			},
			ready: "[data-sheet-panel], [data-panel-tabbar]",
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
	...SETTINGS_SECTIONS.map(
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
		id: "autopilot-panel",
		area: "B",
		title: "Side panel › Autopilot screen",
		open: page => ui(page, "openAutopilotPanel"),
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
];

export function surfacesFor(filter: { area?: string; only?: RegExp }): Surface[] {
	return SURFACES.filter(
		surface => (!filter.area || surface.area === filter.area) && (!filter.only || filter.only.test(surface.id)),
	);
}

export { isPhone };
