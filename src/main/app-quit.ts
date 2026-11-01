/**
 * The quit latch: everything that ends the process goes through `requestQuit()`
 * (or, for an update, a confirmed `quitAndInstall()`), and `before-quit`
 * refuses unless the run is already approved. Without this, ⌘Q SIGTERMs every
 * in-flight agent run with no word to the user; with Continue interrupted work
 * on, those runs continue after the next launch and the quit asks nothing.
 */
import { app, autoUpdater, BrowserWindow, dialog, type MessageBoxOptions } from "electron";
import { type BackgroundWork, backgroundWorkSentence } from "./background-work";
import { markMainStep } from "./hang-watchdog";
import { getMainLanguage, mainT } from "./i18n";
import {
	assessQuitRisk,
	QuitLatch,
	type QuitRisk,
	quitNeedsConfirmation,
	updateRestartConfirmation,
	type WindowTabFact,
} from "./quit-guard";
import { QuitWatchdog, type QuitWatchdogReason } from "./quit-watchdog";
import { writeRuntimeLog } from "./runtime-log";

const latch = new QuitLatch();
let asking = false;
let inventory: () => WindowTabFact[] = () => [];
const forcedExitHooks: Array<() => void> = [];

const quitWatchdog = new QuitWatchdog({
	setTimer: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return timer;
	},
	clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
	log: report => writeRuntimeLog(report),
	exit: () => {
		// `app.exit` skips `will-quit`, so whatever hangs off it (the relaunch swap) runs here first.
		for (const hook of forcedExitHooks) {
			try {
				hook();
			} catch (err) {
				console.warn(`[quit] forced-exit hook failed: ${String(err)}`);
			}
		}
		app.exit(0);
	},
});

/** Run `hook` right before the watchdog force-exits, for work a `will-quit` handler would have done. */
export function onQuitForcedExit(hook: () => void): void {
	forcedExitHooks.push(hook);
}

/** The quit was cancelled after it committed (a failed install keeps the app running): stop the force exit. */
export function disarmQuitWatchdog(reason?: QuitWatchdogReason): void {
	quitWatchdog.disarm(reason);
}

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

/** Whether a quit's running turns continue after the next launch (Settings › General): then nothing asks. */
export function setQuitResumes(resumes: () => boolean): void {
	resumesInterrupted = resumes;
}

/**
 * Ask before a quit (⌘Q, the tray, an update restart) that would stop running
 * work. True when nothing would stop (no run, or the runs continue after the
 * next launch) or the user chose to quit anyway; false when they keep working
 * or a prompt is already open (⌘Q pressed again must not queue a second modal).
 */
export async function confirmQuit(): Promise<boolean> {
	const risk = quitRisk();
	if (!quitNeedsConfirmation(risk, resumesInterrupted())) return true;
	const language = getMainLanguage();
	return askOnce({
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
	});
}

/**
 * Ask before an update restart a person started ("Restart & install", the countdown's "Now", a paired device's
 * apply). Running turns continue after the relaunch, so with Continue interrupted work on this asks only when
 * background subagents or jobs run: it names them (`readWork` asks the omps now) and says they start again after the
 * restart. With the setting off it is the quit confirm. True = go ahead.
 */
export async function confirmUpdateRestart(readWork: () => Promise<BackgroundWork>): Promise<boolean> {
	const resumes = resumesInterrupted();
	if (!resumes) return confirmQuit();
	const work = await readWork();
	if (updateRestartConfirmation(quitRisk(), resumes, work) !== "background work") return true;
	const language = getMainLanguage();
	const what = backgroundWorkSentence(work, (key, params) => mainT(key, language, params));
	return askOnce({
		type: "warning",
		buttons: [mainT("updates.restartWork.restart", language), mainT("updates.restartWork.cancel", language)],
		defaultId: 1,
		cancelId: 1,
		message: mainT("updates.restartWork.title", language),
		detail: mainT("updates.restartWork.body", language, { work: what }),
	});
}

/**
 * One native confirm at a time (⌘Q pressed again, or a second restart click, must not queue a second modal):
 * true when the first button was chosen; false for the second, a dismissal, a failure or a prompt already open.
 */
async function askOnce(options: MessageBoxOptions): Promise<boolean> {
	if (asking) return false;
	asking = true;
	const owner = BrowserWindow.getFocusedWindow();
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
		markMainStep("quit", "before-quit");
		if (latch.proceed(teardown)) {
			// The quit is committed: finalize (which may ask the user) is over and the teardown ran.
			quitWatchdog.arm("quit");
			return;
		}
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
		markMainStep("update", "before-quit-for-update");
		finalizing = "done";
		latch.proceedForUpdate(teardown);
		markMainStep("update", "teardown-done: closing windows for the installer");
		quitWatchdog.arm("update");
	});
}
