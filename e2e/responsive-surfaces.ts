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
/** A portrait tablet at least 800 px wide docks the session list; a phone and the narrower tablet use the drawer. */
const sidebarDocked = (look: Look): boolean => look.width >= 800;

async function openDrawer(page: Page, look: Look): Promise<void> {
	if (sidebarDocked(look)) return;
	await page.locator("button:visible:has(svg.lucide-menu)").first().click();
	await page.locator("[data-drawer]").waitFor({ state: "visible", timeout: 10_000 });
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
		id: "board-strip",
		area: "A",
		title: "Work board where it cannot dock: the status strip under the header, expanded (busy session, ?board=busy)",
		query: "&board=busy",
		when: look => look.width < 1000 || look.orientation === "portrait",
		open: async page => {
			// The busy fixture's turn, question and goal land 1.5 s after boot (dev-harness/boot.ts).
			const chip = page.locator("[data-work-chip][data-state='waiting']");
			await chip.waitFor({ state: "visible", timeout: 15_000 });
			if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
		},
		ready: "[data-work-strip-panel] [data-work-board-panel]",
		settle: 600,
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
	{
		id: "composer-run-settings",
		area: "A",
		title: "Run settings popover (thinking, approval); on a phone it lives behind the composer's ⋯",
		when: look => look.width >= 600,
		open: page => page.locator("[data-run-settings-trigger]").first().click(),
	},
	{
		id: "composer-context-usage",
		area: "A",
		title: "Context usage popover; on a phone it lives behind the composer's ⋯",
		when: look => look.width >= 600,
		open: page => page.locator(".omp-context-usage-trigger").first().click(),
	},
	{
		id: "composer-delegation",
		area: "A",
		title: "Delegation strength popover; on a phone it lives behind the composer's ⋯",
		when: look => look.width >= 600,
		open: page => page.locator("[data-run-settings-trigger]").first().click(),
	},
	{
		id: "composer-more-sheet",
		area: "A",
		title: "A phone's composer ⋯ sheet (mode, model, run settings, context)",
		when: look => look.width < 600,
		open: page => page.locator(".omp-composer-toolbar > button").nth(1).click(),
	},
	{
		id: "composer-attach-menu",
		area: "A",
		title: "Attach and more menu",
		open: page => page.locator(".omp-composer-toolbar > button").first().click(),
	},
	{
		id: "sidebar-row-menu",
		area: "A",
		title: "A session row's action menu",
		open: async (page, look) => {
			await openDrawer(page, look);
			await page.locator("[data-sidebar-row-menu]").first().click();
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
