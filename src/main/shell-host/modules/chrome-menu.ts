/**
 * The `chrome` module's menu area (PROTOCOL.md §15.5): the application menu and the text field's context menu live in
 * the shell. Node gives it what only Node has (the app's name and the accelerators of `shared/hotkeys.ts`: the page
 * shares that file) and delivers the page actions its items ask for.
 */
import * as electron from "electron";
import { nativeAccelerator } from "../../../shared/hotkeys";
import { IPC_EVENTS, type MenuAction } from "../../../shared/ipc-types";
import { chrome } from "./chrome";

/** `ContextMenuParams` as far as the editable menu reads them (Electron's `context-menu` details, PROTOCOL.md §4). */
export interface MenuProbeParams {
	isEditable: boolean;
	misspelledWord?: string;
	dictionarySuggestions?: string[];
	mediaType?: string;
	hasImageContents?: boolean;
	x?: number;
	y?: number;
}

/** A menu item as the shell shows it (PROTOCOL.md §7's `MenuItem`, with the shell's own ids). */
export interface MenuProbeItem {
	id: string;
	label: string;
	type: "normal" | "separator" | "submenu" | "checkbox" | "radio";
	enabled: boolean;
	visible: boolean;
	checked: boolean;
	accelerator?: string;
	role?: string;
	submenu?: MenuProbeItem[];
}

export interface MenuSpec {
	calls: {
		/**
		 * What a menu shows now, and with `click` what choosing the item of that id does: the parity suites' way to look
		 * at and press a native menu (`application` and `tray` take a click; `context` is a dry run for `params`).
		 */
		menuProbe: {
			params: { menu: "application" | "tray" | "context"; params?: MenuProbeParams; click?: string };
			result: { items: MenuProbeItem[] };
		};
	};
	posts: {
		/** The app's name (`app.name`) and the chords the menu shows, as Electron accelerators. */
		menu: {
			appName: string;
			sessionNew: string;
			windowNew: string;
			windowClose: string;
			sessionExportHtml: string;
		};
	};
	events: {
		/** A menu item for the page: the window it goes to (the shell opened one first when none was). */
		menuAction: { winId: number; action: MenuAction };
	};
	asks: Record<never, never>;
}

/**
 * Sends the shell the app's name and the accelerators of the native chords. The shell installs the menu once these
 * and the labels (`publishLabels`) are here, and again whenever the labels change (a language change). Call at start,
 * next to `publishLabels`.
 */
export function publishMenu(appName: string): void {
	void chrome().post("menu", {
		appName,
		sessionNew: nativeAccelerator("session.new"),
		windowNew: nativeAccelerator("window.new"),
		windowClose: nativeAccelerator("window.close"),
		sessionExportHtml: nativeAccelerator("session.exportHtml"),
	});
}

/** The page's window gets the action (`MENU_ACTION`), as the menu's items asked. */
function deliverToWindow(winId: number, action: MenuAction): void {
	electron.BrowserWindow.fromId(winId)?.webContents.send(IPC_EVENTS.MENU_ACTION, { action });
}

/** Delivers the page actions of the menu; returns what stops it. `deliver` is the window's `send` (a test's own). */
export function wireMenuActions(deliver: (winId: number, action: MenuAction) => void = deliverToWindow): () => void {
	return chrome().on("menuAction", ({ winId, action }) => deliver(winId, action));
}

/** `chrome.menuProbe` (a test seam of the parity suites). */
export function menuProbe(
	menu: "application" | "tray" | "context",
	options: { params?: MenuProbeParams; click?: string } = {},
): Promise<MenuProbeItem[]> {
	return chrome()
		.call("menuProbe", { menu, ...options })
		.then(result => result.items);
}
