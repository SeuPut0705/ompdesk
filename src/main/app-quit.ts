/**
 * The quit latch: everything that ends the process goes through `requestQuit()`,
 * and `before-quit` refuses unless the run is already approved. Without this,
 * ⌘Q SIGTERMs every in-flight agent run with no word to the user.
 */
import { app, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { getMainLanguage, mainT } from "./i18n";
import { assessQuitRisk, type QuitRisk, quitNeedsConfirmation, type WindowTabFact } from "./quit-guard";

let approved = false;
let asking = false;
let cleanedUp = false;
let inventory: () => WindowTabFact[] = () => [];

/** True after the user (or a restart prompt) approved the quit. */
export function isQuitting(): boolean {
	return approved;
}

export function requestQuit(): void {
	approved = true;
	app.quit();
}

/** What a quit right now would cost. The resource-change restart quotes it. */
export function quitRisk(): QuitRisk {
	return assessQuitRisk(inventory());
}

/**
 * Ask before a quit that would stop running work. True when nothing is
 * running or the user chose to quit anyway; false when they keep working or a
 * prompt is already open (⌘Q pressed again must not queue a second modal).
 */
export async function confirmQuit(): Promise<boolean> {
	const risk = quitRisk();
	if (!quitNeedsConfirmation(risk)) return true;
	if (asking) return false;
	asking = true;
	const language = getMainLanguage();
	const owner = BrowserWindow.getFocusedWindow();
	const options: MessageBoxOptions = {
		type: "warning",
		buttons: [mainT("quit.quitAnyway", language), mainT("quit.keepWorking", language)],
		defaultId: 1,
		cancelId: 1,
		message: mainT("quit.workingTitle", language),
		detail: mainT("quit.workingBody", language, {
			working: risk.workingTabs,
			total: risk.totalTabs,
			windows: risk.workingWindows,
		}),
	};
	try {
		const result = await (owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options));
		return result.response === 0;
	} catch {
		return false;
	} finally {
		asking = false;
	}
}

/**
 * Register the `before-quit` gate. `tabInventory` reports what the sidecars are
 * doing, `teardown` runs exactly once per approved quit.
 */
export function installQuitGuard(tabInventory: () => WindowTabFact[], teardown: () => void): void {
	inventory = tabInventory;
	app.on("before-quit", event => {
		if (approved) {
			if (cleanedUp) return;
			cleanedUp = true;
			teardown();
			return;
		}
		event.preventDefault();
		void confirmQuit().then(ok => {
			if (ok) requestQuit();
		});
	});
}
