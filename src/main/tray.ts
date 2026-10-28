/**
 * System tray: Open/Hide, one update item that follows the updater, Quit (the
 * user's decision of 29 Oct 2026). The menu is installed again only when a label
 * a user can read changed, and never while it is open.
 */

import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron";
import winTray2x from "../../resources/brand/tray@2x.png?inline";
import winTray from "../../resources/brand/tray.png?inline";
import macTemplate2x from "../../resources/brand/trayTemplate@2x.png?inline";
import macTemplate from "../../resources/brand/trayTemplate.png?inline";
import type { TrayState, UpdateStatus } from "../shared/ipc-types";
import { getMainLanguage } from "./i18n";
import {
	menuSignature,
	type TrayMenuActions,
	type TrayMenuInput,
	trayMenuTemplate,
	trayTooltip,
	trayUpdateItem,
} from "./tray-labels";
import { applyUpdate, checkForUpdate, downloadUpdate, onUpdateStatus, updateStatus } from "./updater";
import type { SpawnWindow, WindowManager } from "./window";

/** How long a finished check that found nothing keeps saying "up to date" before the item offers a check again. */
const UP_TO_DATE_MS = 30_000;

let tray: Tray | null = null;
let windowManagerRef: WindowManager | null = null;
let spawnWindowRef: SpawnWindow | null = null;
let trayState: TrayState | null = null;
/** Label set the currently installed native menu renders, and whether it is open. */
let installedSignature: string | null = null;
let menuIsOpen = false;
let tooltip = "OMPdesk";
let upToDateSince: number | null = null;
let upToDateTimer: NodeJS.Timeout | undefined;
let stopUpdateWatch: (() => void) | null = null;

function buildIcon(): Electron.NativeImage {
	// The OMPdesk mark, rasterized by scripts/gen-icons.ts and inlined as data
	// URLs so the packaged app needs no resource path. macOS status items use
	// the monochrome template (the system tints it for light/dark and selected
	// menu-bar states); Windows gets the full-color tile, which stays visible
	// on light and dark taskbars. The run status is text (the tooltip); painting
	// it here would turn the mark into a noisy status dot.
	const mac = process.platform === "darwin";
	const image = nativeImage.createFromDataURL(mac ? macTemplate : winTray);
	image.addRepresentation({ scaleFactor: 2, dataURL: mac ? macTemplate2x : winTray2x });
	if (mac) image.setTemplateImage(true);
	return image;
}

/** Targets the focused window, not the first-created one, so the toggle acts on the window the user is looking at. */
function toggleWindow(windowManager: WindowManager): void {
	const win = windowManager.getTargetWindow();
	if (win?.isVisible()) win.hide();
	else if (win) {
		win.show();
		win.focus();
	} else spawnWindowRef?.();
}

function upToDateShown(): boolean {
	return upToDateSince !== null && Date.now() - upToDateSince < UP_TO_DATE_MS;
}

function menuInput(windowManager: WindowManager): TrayMenuInput {
	const lang = trayState?.language ?? getMainLanguage();
	return {
		lang,
		windowVisible: windowManager.getTargetWindow()?.isVisible() ?? false,
		update: trayUpdateItem(lang, updateStatus(), upToDateShown()),
	};
}

function menuActions(windowManager: WindowManager): TrayMenuActions {
	return {
		toggleWindow: () => toggleWindow(windowManager),
		update: action => {
			if (action === "check") void checkForUpdate();
			else if (action === "download") void downloadUpdate();
			else void applyUpdate();
		},
		quit: () => app.quit(),
	};
}

/**
 * Install a menu built from the current state. The instance remembers whether
 * the user has it open: a change that lands mid-open is recorded but not installed
 * (replacing the menu underneath dismisses it), and flushes when it closes.
 */
function installMenu(): void {
	if (!tray || !windowManagerRef) return;
	const input = menuInput(windowManagerRef);
	installedSignature = menuSignature(input);
	const menu = Menu.buildFromTemplate(trayMenuTemplate(input, menuActions(windowManagerRef)));
	menu.on("menu-will-show", () => {
		menuIsOpen = true;
	});
	menu.on("menu-will-close", () => {
		menuIsOpen = false;
		refreshMenu();
	});
	tray.setContextMenu(menu);
}

function refreshMenu(): void {
	if (!tray || !windowManagerRef || menuIsOpen) return;
	if (menuSignature(menuInput(windowManagerRef)) === installedSignature) return;
	installMenu();
}

function onUpdate(status: UpdateStatus): void {
	clearTimeout(upToDateTimer);
	if (status.state === "not-available") {
		upToDateSince = Date.now();
		upToDateTimer = setTimeout(refreshMenu, UP_TO_DATE_MS + 50);
		upToDateTimer.unref();
	} else {
		upToDateSince = null;
	}
	refreshMenu();
}

function watchWindow(win: BrowserWindow): void {
	win.on("show", refreshMenu);
	win.on("hide", refreshMenu);
	win.on("minimize", refreshMenu);
	win.on("restore", refreshMenu);
	win.on("closed", refreshMenu);
}

export function createTray(windowManager: WindowManager, spawnWindow: SpawnWindow): Tray {
	windowManagerRef = windowManager;
	spawnWindowRef = spawnWindow;
	tray = new Tray(buildIcon());
	tray.setToolTip(trayTooltip(null));
	installMenu();

	for (const win of BrowserWindow.getAllWindows()) watchWindow(win);
	app.on("browser-window-created", (_event, win) => watchWindow(win));
	stopUpdateWatch = onUpdateStatus(onUpdate);

	tray.on("click", () => {
		const win = windowManager.getTargetWindow();
		if (win) {
			win.show();
			win.focus();
		} else {
			spawnWindowRef?.();
		}
	});

	return tray;
}

/**
 * Renderer pushed a fresh snapshot. Hover text tracks the status; the native
 * menu is rebuilt only when a label a user can read actually changed (the
 * language), so the per-append session refresh stops swapping menus.
 */
export function setTrayState(state: TrayState): void {
	trayState = state;
	const nextTooltip = trayTooltip(state);
	if (nextTooltip !== tooltip && tray) {
		tooltip = nextTooltip;
		tray.setToolTip(nextTooltip);
	}
	refreshMenu();
}

/** The tray item exists (never in headless test runs): a hidden window can come back from it. */
export function hasTray(): boolean {
	return tray !== null;
}

export function destroyTray(): void {
	stopUpdateWatch?.();
	stopUpdateWatch = null;
	clearTimeout(upToDateTimer);
	upToDateTimer = undefined;
	upToDateSince = null;
	tray?.destroy();
	tray = null;
	windowManagerRef = null;
	trayState = null;
	installedSignature = null;
	menuIsOpen = false;
	tooltip = "OMPdesk";
}
