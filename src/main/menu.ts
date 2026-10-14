/**
 * Native application menu for ompdesk.
 */
import { app, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { nativeAccelerator } from "../shared/hotkeys";
import { IPC_EVENTS, type MenuAction } from "../shared/ipc-types";
import { editRoleItems } from "./editable-context-menu";
import { editLabels, getMainLanguage, mainT } from "./i18n";
import type { SpawnWindow, WindowManager } from "./window";

function sendMenuAction(windowManager: WindowManager, spawnWindow: SpawnWindow, action: MenuAction): void {
	const win = windowManager.getTargetWindow();
	if (win) {
		win.webContents.send(IPC_EVENTS.MENU_ACTION, { action });
		return;
	}
	// No windows open (macOS keep-running): spawn one and deliver once its
	// renderer is up, instead of dropping the action silently.
	const created = spawnWindow();
	created?.once("ready-to-show", () => {
		if (!created.isDestroyed()) created.webContents.send(IPC_EVENTS.MENU_ACTION, { action });
	});
}

export function createMenu(windowManager: WindowManager, spawnWindow: SpawnWindow): void {
	const language = getMainLanguage();
	// Chord rule: a shortcut the renderer keymap owns must NOT also be a menu
	// accelerator. Electron resolves menu accelerators before the keydown reaches
	// the webContents, so the duplicate would fire while the user's remap of the
	// same action stayed dead. Menu-only chords live in shared/hotkeys.ts, which
	// the keymap reads as reserved.
	const template: MenuItemConstructorOptions[] = [
		...(process.platform === "darwin"
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" as const, label: mainT("menu.about", language) },
							{
								label: mainT("menu.checkUpdates", language),
								click: () => sendMenuAction(windowManager, spawnWindow, "check-updates"),
							},
							{ type: "separator" as const },
							{
								label: mainT("menu.settings", language),
								// No accelerator: ⌘, (and its ⌃, twin) belong to the renderer
								// keymap so users can remap them.
								click: () => sendMenuAction(windowManager, spawnWindow, "open-settings"),
							},
							{ type: "separator" as const },
							{ role: "services" as const, label: mainT("menu.services", language) },
							{ type: "separator" as const },
							{ role: "hide" as const, label: mainT("menu.hide", language) },
							{ role: "hideOthers" as const, label: mainT("menu.hideOthers", language) },
							{ role: "unhide" as const, label: mainT("menu.showAll", language) },
							{ type: "separator" as const },
							{ role: "quit" as const, label: mainT("menu.quit", language) },
						],
					},
				]
			: []),
		{
			label: mainT("menu.file", language),
			submenu: [
				{
					label: mainT("menu.openProject", language),
					// No accelerator: ⌘⇧O is owned by the globalShortcut window
					// toggle (index.ts). Registering it here too makes macOS fire
					// both (dialog + hide) and Windows swallow the menu shortcut
					// entirely. The menu item stays clickable.
					click: () => sendMenuAction(windowManager, spawnWindow, "open-project"),
				},
				{ type: "separator" },
				{
					label: mainT("menu.newSession", language),
					accelerator: nativeAccelerator("session.new"),
					click: () => sendMenuAction(windowManager, spawnWindow, "new-session"),
				},
				{
					// No accelerator: ⌘T/⇧⌘T live in the renderer keymap so users can
					// remap them. A menu accelerator would fire first and make the
					// remappable chords dead (precedent: ⌘⇧O above).
					label: mainT("menu.newTab", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "new-tab"),
				},
				{
					label: mainT("menu.newChatTab", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "new-chat-tab"),
				},
				{
					label: mainT("menu.newWindow", language),
					accelerator: nativeAccelerator("window.new"),
					click: () => {
						// Open a parallel window in the target window's project (its
						// sidecar keeps running untouched in the current window). With no
						// project to inherit, spawn without a cwd: that is the request for
						// the GUI-owned workspace, whereas the process cwd is "/" for an
						// app launched from Finder.
						const win = windowManager.getTargetWindow();
						spawnWindow(win ? windowManager.recordFor(win)?.cwd : undefined);
					},
				},
				...(process.platform === "darwin"
					? []
					: [
							{ type: "separator" as const },
							{
								label: mainT("menu.settings", language),
								// No accelerator: the renderer keymap owns ⌘, so users can remap it.
								click: () => sendMenuAction(windowManager, spawnWindow, "open-settings"),
							},
						]),
			],
		},
		{
			label: mainT("menu.edit", language),
			submenu: editRoleItems(editLabels(language)),
		},
		{
			label: mainT("menu.view", language),
			submenu: [
				{
					label: mainT("menu.commandCenter", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-command-center"),
				},
				{
					label: mainT("menu.contextReport", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-context-report"),
				},
				{
					label: mainT("menu.stats", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-stats"),
				},
				{
					label: mainT("menu.jobs", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-jobs"),
				},
				{
					label: mainT("menu.hotkeys", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-hotkeys"),
				},
				{ type: "separator" },
				{
					label: mainT("menu.toggleSidebar", language),
					// No accelerator: ⌘B/⌃B belong to the renderer keymap.
					click: () => sendMenuAction(windowManager, spawnWindow, "toggle-sidebar"),
				},
				{
					label: mainT("menu.togglePanel", language),
					// No accelerator: ⌘J/⌃J belong to the renderer keymap.
					click: () => sendMenuAction(windowManager, spawnWindow, "toggle-panel"),
				},
				{ type: "separator" },
				{ role: "reload", label: mainT("menu.reload", language) },
				{ role: "forceReload", label: mainT("menu.forceReload", language) },
				{ role: "toggleDevTools", label: mainT("menu.toggleDevTools", language) },
				{ type: "separator" },
				{ role: "resetZoom", label: mainT("menu.actualSize", language) },
				{ role: "zoomIn", label: mainT("menu.zoomIn", language) },
				{ role: "zoomOut", label: mainT("menu.zoomOut", language) },
				{ type: "separator" },
				{ role: "togglefullscreen", label: mainT("menu.toggleFullScreen", language) },
			],
		},
		{
			// The macOS habit this serves: ⌘W closes a TAB, ⇧⌘W closes the window.
			// A window-level `close` role in File meant the first ⌘W killed
			// the whole window — every tab and sidecar in it.
			label: mainT("menu.window", language),
			submenu: [
				{
					label: mainT("menu.closeTab", language),
					// No accelerator: ⌘W belongs to the renderer keymap so users can
					// remap it; a menu accelerator would fire first (precedent: ⌘T).
					click: () => sendMenuAction(windowManager, spawnWindow, "close-tab"),
				},
				{
					label: mainT("menu.closeWindow", language),
					accelerator: nativeAccelerator("window.close"),
					click: () => windowManager.getTargetWindow()?.close(),
				},
				{ type: "separator" },
				{ role: "minimize", label: mainT("menu.minimize", language) },
				...(process.platform === "darwin"
					? [
							{ role: "zoom" as const, label: mainT("menu.zoom", language) },
							{ type: "separator" as const },
							{ role: "front" as const, label: mainT("menu.bringAllToFront", language) },
						]
					: []),
			],
		},
		{
			label: mainT("menu.session", language),
			submenu: [
				{
					label: mainT("menu.importSession", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-import"),
				},
				{
					label: mainT("menu.branchPicker", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-branch-picker"),
				},
				{
					label: mainT("menu.sessionTree", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-session-tree"),
				},
				{ type: "separator" },
				{
					label: mainT("menu.sessionInfo", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-session-info"),
				},
				{
					label: mainT("menu.shareSession", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-share-session"),
				},
				{
					label: mainT("menu.exportHtml", language),
					accelerator: nativeAccelerator("session.exportHtml"),
					click: () => sendMenuAction(windowManager, spawnWindow, "export-html"),
				},
				{
					label: mainT("menu.handoff", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "handoff"),
				},
			],
		},
		{
			label: mainT("menu.tools", language),
			submenu: [
				{
					label: mainT("menu.agentHub", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-agent-hub"),
				},
				{
					label: mainT("menu.modes", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-modes"),
				},
				{
					label: mainT("menu.providers", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-providers"),
				},
				{
					label: mainT("menu.modelRoles", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-model-roles"),
				},
				{
					label: mainT("menu.modelPicker", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-model-picker"),
				},
				{
					label: mainT("menu.capabilities", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-capabilities"),
				},
				{
					label: mainT("menu.usage", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-usage"),
				},
				{ type: "separator" },
				{
					label: mainT("menu.extensions", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-extensions"),
				},
				{
					label: mainT("menu.inventory", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-inventory"),
				},
				{
					label: mainT("menu.prCenter", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-pr-center"),
				},
				{
					label: mainT("menu.workspaceDirs", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-workspace-dirs"),
				},
				{
					label: mainT("menu.workspaceChanges", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-git"),
				},
				{
					label: mainT("menu.restartCore", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "restart-sidecar"),
				},
				{ type: "separator" },
				{
					label: mainT("menu.debugConsole", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-debug"),
				},
			],
		},
		{
			label: mainT("menu.help", language),
			submenu: [
				{
					label: mainT("menu.about", language),
					click: () => app.showAboutPanel(),
				},
				// macOS has it in the app menu; Windows has no app menu.
				...(process.platform === "darwin"
					? []
					: [
							{
								label: mainT("menu.checkUpdates", language),
								click: () => sendMenuAction(windowManager, spawnWindow, "check-updates"),
							},
						]),
				{
					label: mainT("menu.reportIssue", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "open-feedback"),
				},
				{
					label: mainT("menu.documentation", language),
					click: () => void shell.openExternal("https://github.com/SeuPut0705/ompdesk"),
				},
			],
		},
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
