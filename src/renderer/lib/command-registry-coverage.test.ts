/**
 * The command palette reaches every command the app has: each native menu
 * item and each remappable shortcut has a palette row, and the row shows the
 * chord that actually fires it (the user's remap, not the default).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MenuAction } from "../../shared/ipc-types";
import { buildCommandMenu, type CommandMenuItem, type CommandRegistryContext } from "./command-registry";
import { setLanguageOverride, translate } from "./i18n";
import { actionKbd, KEYMAP_ACTIONS, type KeymapActionId } from "./keymap";

const ok = () => ({ type: "response" as const, command: "x", success: true as const });

const ctx: CommandRegistryContext = {
	t: translate,
	isStreaming: false,
	fastModeEnabled: false,
	autoCompaction: false,
	autoRetry: false,
	planModeEnabled: false,
	prewalkArmed: false,
	availableCommands: [],
	openModelPicker: () => {},
	openSettings: () => {},
	openProviders: () => {},
	openFeedback: () => {},
	openRenameDialog: () => {},
	openSessionPicker: () => {},
	openBranchPicker: () => {},
	openSessionTree: () => {},
	openBenchmark: () => {},
	openHandoffDialog: () => {},
	openThemePicker: () => {},
	openModes: () => {},
	openAgents: () => {},
	openInsights: () => {},
	openImportDialog: () => {},
	openProviderConfig: () => {},
	focusDockCard: () => {},
	retryTurn: async () => {},
	retryLastTurn: async () => {},
	forkSession: async () => {},
	hydrateSession: async () => {},
	rpc: {
		setFastMode: async () => ok(),
		setAutoCompaction: async () => ok(),
		setAutoRetry: async () => ok(),
		compact: async () => ok(),
		newSession: async () => {},
		setPlanMode: async () => ok(),
		setPrewalk: async () => ok(),
		cycleModel: async () => {},
		cycleThinkingLevel: async () => {},
	},
};

/** Palette row for each native menu action; null where the palette itself is the target. */
const MENU_ROWS: Record<MenuAction, string | null> = {
	"new-session": "new",
	"new-tab": "new-tab",
	"new-chat-tab": "new-chat-tab",
	"close-tab": "close-tab",
	"open-project": "open-project",
	"toggle-sidebar": "toggle-sidebar",
	"toggle-panel": "toggle-panel",
	"open-settings": "settings",
	"check-updates": "check-updates",
	"open-usage": "usage",
	"open-command-center": null,
	"open-context-report": "context",
	"open-jobs": "jobs",
	"open-stats": "stats",
	"open-feedback": "feedback",
	"open-hotkeys": "hotkeys",
	"open-session-info": "session",
	"open-share-session": "share",
	"open-import": "import",
	"open-branch-picker": "branch",
	"open-session-tree": "tree",
	"open-capabilities": "settings",
	"open-model-picker": "model",
	"open-git": "git",
	"restart-sidecar": "restart",
	"open-workspace-dirs": "dirs",
	"open-agent-hub": "agents",
	"open-modes": "modes",
	"open-providers": "providers",
	"open-model-roles": "model-roles",
	"open-extensions": "extensions",
	"open-inventory": "plugins",
	"open-pr-center": "prs",
	"open-debug": "debug",
	"export-html": "export",
	handoff: "handoff",
	"toggle-fast": "fast",
	"cycle-thinking": "thinking cycle",
	"set-approval": null,
	"toggle-language": null,
	"switch-project": null,
};

/** Palette row for each remappable shortcut; null where a palette row makes no sense. */
const SHORTCUT_ROWS: Record<KeymapActionId, string | null> = {
	"model.cycleForward": "model cycle",
	"model.cycleBackward": null,
	retry: "retry",
	"pr.center": "prs",
	dequeue: "dequeue",
	"plan.toggle": "plan",
	"tools.expand": "expand-tools",
	"thinking.toggle": "toggle-thinking-blocks",
	"model.select": "model",
	"agents.hub": "hub",
	palette: null,
	"tab.new": "new-tab",
	"tab.newChat": "new-chat-tab",
	"tab.newWorktree": "new-worktree-tab",
	"tab.close": "close-tab",
	"tab.reopen": "reopen-tab",
	"tab.next": null,
	"tab.prev": null,
	"tab.switcher": null,
	"tab.switcherBack": null,
	"tab.overview": null,
	"nav.back": null,
	"nav.forward": null,
	"pane.focusUp": null,
	"pane.focusDown": null,
	"pane.focusLeft": null,
	"pane.focusRight": null,
	"pane.next": null,
	"pane.prev": null,
	"tab.goto1": null,
	"tab.goto2": null,
	"tab.goto3": null,
	"tab.goto4": null,
	"tab.goto5": null,
	"tab.goto6": null,
	"tab.goto7": null,
	"tab.goto8": null,
	"tab.gotoLast": null,
	quickOpen: "quick-open",
	"sessions.search": "resume",
	"files.search": "search-files",
	settings: "settings",
	"sidebar.toggle": "toggle-sidebar",
	"panel.toggle": "toggle-panel",
	"panel.terminal": "terminal",
	"panel.diff": "git",
	"panel.preview": "preview",
	"panel.files": "files",
	"panel.jobs": "jobs",
	"panel.plan": "plan-panel",
	"panel.logs": "logs",
	"panel.queue": "queue-panel",
	"panel.tree": "tree-panel",
	"panel.memory": "memory-panel",
	hotkeys: "hotkeys",
};

const row = (items: CommandMenuItem[], name: string) => items.find(item => item.name === name);

beforeEach(() => {
	(globalThis as Record<string, unknown>).window = { omp: { rpc: {} } };
});
afterEach(() => {
	delete (globalThis as Record<string, unknown>).window;
});

describe("command palette coverage", () => {
	it("has a row for every native menu item", () => {
		const items = buildCommandMenu(ctx);
		for (const [action, name] of Object.entries(MENU_ROWS)) {
			if (name === null) continue;
			expect(row(items, name), `${action} → ${name}`).toBeDefined();
		}
	});

	it("has a row for every remappable shortcut and shows its default chord", () => {
		const items = buildCommandMenu(ctx);
		for (const action of KEYMAP_ACTIONS) {
			const name = SHORTCUT_ROWS[action.id];
			if (name === null) continue;
			const item = row(items, name);
			expect(item, `${action.id} → ${name}`).toBeDefined();
			// Panel views have no default chord until the user binds one.
			expect(item?.shortcut ?? "", action.id).toBe(actionKbd(action.id));
		}
	});

	it("shows the user's remapped chord instead of the default", () => {
		const items = buildCommandMenu({
			...ctx,
			keymapOverrides: { "tab.new": ["⌥⌘N"], "panel.terminal": ["⌃`"], hotkeys: ["⌥/"] },
		});
		expect(row(items, "new-tab")?.shortcut).toBe("⌥⌘N");
		expect(row(items, "terminal")?.shortcut).toBe("⌃`");
		expect(row(items, "hotkeys")?.shortcut).toBe("⌥/");
	});

	it("shows the remapped chord on every row a shortcut backs", () => {
		const remapped = Object.fromEntries(KEYMAP_ACTIONS.map(action => [action.id, ["⌥⌘F9"]]));
		const items = buildCommandMenu({ ...ctx, keymapOverrides: remapped });
		for (const action of KEYMAP_ACTIONS) {
			const name = SHORTCUT_ROWS[action.id];
			if (name === null) continue;
			expect(row(items, name)?.shortcut, action.id).toBe("⌥⌘F9");
		}
	});

	it.each(["en", "ko"] as const)("lists only rows that can run, with real copy (%s)", language => {
		setLanguageOverride(language);
		try {
			const walk = (items: CommandMenuItem[], trail: string): void => {
				const names = new Set<string>();
				for (const item of items) {
					const where = `${trail}${item.name}`;
					expect(names.has(item.name), `${where} listed twice`).toBe(false);
					names.add(item.name);
					for (const copy of [item.label, item.description ?? ""]) {
						expect(copy, `${where} shows a raw locale key`).not.toMatch(/^(cmd|palette|input)\.[\w.]+$/);
					}
					expect(item.label.trim(), `${where} has no label`).not.toBe("");
					const { affordance } = item;
					if (affordance.kind === "submenu") {
						expect(affordance.items.length, `${where} opens an empty submenu`).toBeGreaterThan(0);
						walk(affordance.items, `${where} › `);
					} else if (affordance.kind === "prompt") {
						expect(affordance.text.startsWith("/"), `${where} sends ${affordance.text}`).toBe(true);
					} else if (affordance.kind === "unavailable") {
						expect(affordance.reason.trim(), `${where} is dead without a reason`).not.toBe("");
					}
				}
			};
			walk(buildCommandMenu(ctx), "");
		} finally {
			setLanguageOverride(null);
		}
	});
});
