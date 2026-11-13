/**
 * The `chrome` module's quit area (PROTOCOL.md §15.5; was `app-quit.ts`): the shell owns the approval, the two
 * confirmations and the exit watchdog; this keeps Node's orchestration of a quit (`before-quit`, `will-quit`,
 * `before-quit-for-update`: finalize, teardown, settled) and a synchronous mirror of the approval for the callers that
 * read it inline.
 */
import { app, autoUpdater } from "electron";
import {
	type BackgroundWork,
	backgroundWorkSentence,
	hasBackgroundWork,
	NO_BACKGROUND_WORK,
} from "../../background-work";
import { getMainLanguage, mainT } from "../../i18n";
import { assessQuitRisk, type QuitRisk, type WindowTabFact } from "../../quit-guard";
import { chrome } from "./chrome";
import { markMainStep } from "./chrome-hang";

export type QuitWatchdogReason = "quit" | "update";

type NoParams = Record<string, never>;

export interface QuitSpec {
	calls: {
		/** A quit nobody approved yet (Node's `before-quit` saw one): the shell asks first when it must. */
		quit: { params: NoParams; result: { approved: boolean } };
		confirmQuit: { params: NoParams; result: { ok: boolean } };
		confirmUpdateRestart: { params: NoParams; result: { ok: boolean } };
	};
	posts: {
		/** `requestQuit()`: the caller approved the quit. */
		approve: NoParams;
		/** The teardown ran: the shell arms its exit watchdog. */
		committed: { reason: QuitWatchdogReason };
		/** An install that failed keeps the app: the watchdog stops. */
		disarm: { reason?: QuitWatchdogReason };
	};
	events: {
		/** The quit is approved; `run`: the shell approved it, so Node runs `app.quit()`. */
		approved: { run: boolean };
	};
	asks: {
		quitFacts: { params: NoParams; result: QuitRisk & { resumes: boolean } };
		backgroundWork: { params: NoParams; result: { has: boolean; sentence: string } };
		forcedExit: { params: { reason: QuitWatchdogReason; timeoutMs: number }; result: NoParams };
	};
}

/** Mirror of the shell's approval: set by `requestQuit()` and by `chrome.approved`, never cleared. */
let approvedMirror = false;
let inventory: () => WindowTabFact[] = () => [];
let resumesInterrupted: () => boolean = () => false;
let readWork: () => Promise<BackgroundWork> = async () => NO_BACKGROUND_WORK;
const forcedExitHooks: Array<() => void> = [];

function warn(what: string): (error: unknown) => void {
	return error => console.warn(`[quit] ${what}: ${String(error)}`);
}

/** Run `hook` right before the watchdog force-exits, for work a `will-quit` handler would have done. */
export function onQuitForcedExit(hook: () => void): void {
	forcedExitHooks.push(hook);
}

/** The quit was cancelled after it committed (a failed install keeps the app running): stop the force exit. */
export function disarmQuitWatchdog(reason?: QuitWatchdogReason): void {
	void chrome()
		.post("disarm", reason === undefined ? {} : { reason })
		.catch(warn("disarm"));
}

export function requestQuit(): void {
	approvedMirror = true;
	void chrome().post("approve", {}).catch(warn("approve"));
	app.quit();
}

/** A quit is underway (approved): windows must close, not hide to the tray. */
export function quitApproved(): boolean {
	return approvedMirror;
}

/** What a quit right now would cost. The resource-change restart quotes it. */
export function quitRisk(): QuitRisk {
	return assessQuitRisk(inventory());
}

/** Whether a quit's running turns continue after the next launch (Settings › General): then nothing asks. */
export function setQuitResumes(resumes: () => boolean): void {
	resumesInterrupted = resumes;
}

/**
 * Ask before a quit (⌘Q, the tray, an update restart) that would stop running work. True when nothing would stop (no
 * run, or the runs continue after the next launch) or the user chose to quit anyway; false when they keep working or
 * a prompt is already open.
 */
export async function confirmQuit(): Promise<boolean> {
	return (await chrome().call("confirmQuit", {})).ok;
}

/**
 * Ask before an update restart a person started ("Restart & install", the countdown's "Now", a paired device's apply).
 * Running turns continue after the relaunch, so with Continue interrupted work on this asks only when background
 * subagents or jobs run: `work` reads them fresh when the shell asks. With the setting off it is the quit confirm.
 * True = go ahead.
 */
export async function confirmUpdateRestart(work: () => Promise<BackgroundWork>): Promise<boolean> {
	readWork = work;
	try {
		return (await chrome().call("confirmUpdateRestart", {})).ok;
	} finally {
		readWork = async () => NO_BACKGROUND_WORK;
	}
}

/**
 * Register the `before-quit` gate and serve the shell's asks. `tabInventory` reports what the sidecars are doing,
 * `teardown` runs exactly once per approved quit — ⌘Q and an update's `quitAndInstall()` alike. `finalize` runs once
 * between approval and the teardown, with the windows still up (worktree-lifecycle.ts asks there); the quit resumes
 * when it settles. An update's quit skips it: Squirrel has already closed the windows, and the saved tabs come back
 * after the update. `settled` (what the teardown started and the exit must not cut off) holds the exit in `will-quit`:
 * until every omp has exited, so a stuck one is killed by its stop instead of outliving the app (8 Nov 2026: seven
 * did, for minutes, after an update's relaunch), and until the core wrote the schedules' journal, which main's exit
 * would cut off on Windows. Each part bounds itself.
 */
export function installQuitGuard(
	tabInventory: () => WindowTabFact[],
	teardown: () => void,
	finalize: () => Promise<void>,
	settled: () => Promise<void>,
): void {
	inventory = tabInventory;
	chrome().serve("quitFacts", () => ({ ...assessQuitRisk(inventory()), resumes: resumesInterrupted() }));
	chrome().serve("backgroundWork", async () => {
		const work = await readWork();
		const language = getMainLanguage();
		return {
			has: hasBackgroundWork(work),
			sentence: backgroundWorkSentence(work, (key, params) => mainT(key, language, params)),
		};
	});
	chrome().serve("forcedExit", () => {
		// `app.exit` skips `will-quit`, so whatever hangs off it (the relaunch swap) runs here first.
		for (const hook of forcedExitHooks) {
			try {
				hook();
			} catch (err) {
				console.warn(`[quit] forced-exit hook failed: ${String(err)}`);
			}
		}
		return {};
	});
	chrome().on("approved", ({ run }) => {
		approvedMirror = true;
		if (run) app.quit();
	});

	let finalizing: "pending" | "running" | "done" = "pending";
	let exiting = false;
	let tornDown = false;
	const runTeardown = (): void => {
		if (tornDown) return;
		tornDown = true;
		teardown();
	};
	// Every `will-quit` listener (the relaunch swap, flushes) has run once this one holds the exit; `app.exit` then ends the
	// process without a second `will-quit`.
	app.on("will-quit", event => {
		if (exiting) return;
		exiting = true;
		event.preventDefault();
		markMainStep("quit", "will-quit: waiting for every omp to exit and the schedules' journal");
		void settled()
			.catch((err: unknown) => console.warn(`[quit] the last stops failed: ${String(err)}`))
			.finally(() => {
				markMainStep("quit", "omps exited, schedules saved");
				app.exit(0);
			});
	});
	app.on("before-quit", event => {
		if (approvedMirror && finalizing !== "done") {
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
		if (approvedMirror) {
			runTeardown();
			// The quit is committed: finalize (which may ask the user) is over and the teardown ran.
			void chrome().post("committed", { reason: "quit" }).catch(warn("committed"));
			return;
		}
		// Nobody approved it: the shell asks if it must, then answers `approved` and Node quits again.
		event.preventDefault();
		void chrome().call("quit", {}).catch(warn("quit"));
	});
	// electron-updater emits this from `quitAndInstall()` (Squirrel natively, NSIS once its installer started), only
	// after updater.ts confirmed. Squirrel then closes every window before `before-quit`, and a closing window takes
	// its tabs and their saved layout with it.
	autoUpdater.on("before-quit-for-update", () => {
		markMainStep("update", "before-quit-for-update");
		finalizing = "done";
		approvedMirror = true;
		void chrome().post("approve", {}).catch(warn("approve"));
		// ⌘Q's teardown while the windows and their tabs are still alive.
		runTeardown();
		markMainStep("update", "teardown-done: closing windows for the installer");
		void chrome().post("committed", { reason: "update" }).catch(warn("committed"));
	});
}
