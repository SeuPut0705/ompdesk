/**
 * The quit latch: everything that ends the process goes through `requestQuit()`
 * (or, for an update, a confirmed `quitAndInstall()`), and `before-quit`
 * refuses unless the run is already approved. Without this, ⌘Q SIGTERMs every
 * in-flight agent run with no word to the user.
 */
import { app, autoUpdater, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { getMainLanguage, mainT } from "./i18n";
import { assessQuitRisk, QuitLatch, type QuitRisk, quitNeedsConfirmation, type WindowTabFact } from "./quit-guard";

const latch = new QuitLatch();
let asking = false;
let inventory: () => WindowTabFact[] = () => [];

export function requestQuit(): void {
	latch.approve();
	app.quit();
}

/** A quit is underway (approved): windows must close, not hide to the tray. */
export function quitApproved(): boolean {
	return latch.approved;
}

/** What a quit right now would cost. The resource-change restart quotes it. */
export function quitRisk(): QuitRisk {
	return assessQuitRisk(inventory());
}

let resumesInterrupted: () => boolean = () => false;

/** Whether a quit's running turns continue after the next launch (Settings › General); the confirmation says so. */
export function setQuitResumes(resumes: () => boolean): void {
	resumesInterrupted = resumes;
}

/**
 * Ask before a quit that would stop running work. True when nothing is
 * running or the user chose to quit anyway; false when they keep working or a
 * prompt is already open (⌘Q pressed again must not queue a second modal).
 */
export async function confirmQuit(restart = false): Promise<boolean> {
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
		detail: mainT(
			resumesInterrupted() ? (restart ? "quit.workingBodyRestart" : "quit.workingBodyResume") : "quit.workingBody",
			language,
			{
				working: risk.workingTabs,
				total: risk.totalTabs,
				windows: risk.workingWindows,
			},
		),
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
 * doing, `teardown` runs exactly once per approved quit — ⌘Q and an update's
 * `quitAndInstall()` alike. `finalize` runs once between approval and the
 * teardown, with the windows still up (worktree-lifecycle.ts asks there); the
 * quit resumes when it settles. An update's quit skips it: Squirrel has already
 * closed the windows, and the saved tabs come back after the update.
 */
export function installQuitGuard(
	tabInventory: () => WindowTabFact[],
	teardown: () => void,
	finalize: () => Promise<void>,
): void {
	inventory = tabInventory;
	let finalizing: "pending" | "running" | "done" = "pending";
	app.on("before-quit", event => {
		if (latch.approved && finalizing !== "done") {
			event.preventDefault();
			if (finalizing === "pending") {
				finalizing = "running";
				void finalize()
					.catch((err: unknown) => console.warn(`[quit] finalize failed: ${String(err)}`))
					.finally(() => {
						finalizing = "done";
						app.quit();
					});
			}
			return;
		}
		if (latch.proceed(teardown)) return;
		event.preventDefault();
		void confirmQuit().then(ok => {
			if (ok) requestQuit();
		});
	});
	// electron-updater emits this from `quitAndInstall()` (Squirrel natively,
	// NSIS once its installer started), only after updater.ts confirmed.
	// Squirrel then closes every window before `before-quit`, and a closing
	// window takes its tabs and their saved layout with it.
	autoUpdater.on("before-quit-for-update", () => {
		finalizing = "done";
		latch.proceedForUpdate(teardown);
	});
}
