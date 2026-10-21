/**
 * The "sessions are still working" inventory behind the ⌘Q confirmation, and
 * the approval latch every quit passes.
 *
 * Deliberately electron-free: the main process can only be unit-tested through
 * pure modules like this one, so the risk assessment (what counts as in-flight
 * work, which windows to name in the message) and the latch live here while
 * `app-quit.ts` keeps just the dialog and the event wiring.
 */

export interface WindowTabFact {
	windowId: number;
	tabId: string;
	/** A run or an automatic compaction is in flight on this tab. */
	inFlight: boolean;
}

export interface QuitRisk {
	workingTabs: number;
	totalTabs: number;
	/** Windows holding at least one working tab — the dialog names the count. */
	workingWindows: number;
}

export function assessQuitRisk(facts: readonly WindowTabFact[]): QuitRisk {
	const workingWindows = new Set<number>();
	let workingTabs = 0;
	for (const fact of facts) {
		if (!fact.inFlight) continue;
		workingTabs++;
		workingWindows.add(fact.windowId);
	}
	return { workingTabs, totalTabs: facts.length, workingWindows: workingWindows.size };
}

/**
 * Idle tabs die quietly. Live agent runs ask first only when quitting stops them: with
 * Settings › General › Continue interrupted work on (`resumes`), a quit, an update restart or a
 * crash leaves their markers and the next launch continues them (turn-resume.ts), so nothing asks.
 */
export function quitNeedsConfirmation(risk: QuitRisk, resumes: boolean): boolean {
	return risk.workingTabs > 0 && !resumes;
}

/** What closing the last shown window does. */
export type LastWindowClose = "close" | "hide" | "quit";

/**
 * Closing a window while no other window is shown. An approved quit lets every window close.
 * macOS hides it, so the window, its tabs and their omp processes keep running and the Dock icon
 * shows the same window again. Elsewhere close-to-tray hides it; otherwise the app quits with it,
 * and that quit is asked for before the window goes, like any quit: the confirmation for
 * running work, then the tabs end with the quit approved, so their resume markers stay
 * (turn-resume.ts). A window closed first ends its tabs as if their turns had finished, and
 * `window-all-closed` quits afterwards with neither.
 */
export function lastWindowCloseAction(facts: {
	platform: NodeJS.Platform;
	quitApproved: boolean;
	/** A tray exists and Settings › General › Window has close-to-tray on (not asked on macOS). */
	closeToTray: boolean;
}): LastWindowClose {
	if (facts.quitApproved) return "close";
	if (facts.platform === "darwin") return "hide";
	return facts.closeToTray ? "hide" : "quit";
}

/** What a Dock click (macOS `activate`) does. */
export type ActivateAction = "spawn" | "show" | "ignore";

/**
 * A Dock click opens a window when none is left and brings a hidden one back. Once a quit is approved it does
 * neither: the services are torn down (or going down), and a window restored on them cannot open a paired host's tab,
 * which then leaves the saved layout (21 Oct 2026: an update restart's first quit stalled and the Dock click rebuilt
 * the session on a disposed `RemoteDevices`).
 */
export function activateAction(facts: {
	quitApproved: boolean;
	windowCount: number;
	anyVisible: boolean;
}): ActivateAction {
	if (facts.quitApproved) return "ignore";
	if (facts.windowCount === 0) return "spawn";
	return facts.anyVisible ? "ignore" : "show";
}

/**
 * The approval behind `before-quit`: refused until a confirmation (or a
 * restart prompt) approves it, then the app's teardown runs exactly once.
 */
export class QuitLatch {
	#approved = false;
	#tornDown = false;

	get approved(): boolean {
		return this.#approved;
	}

	approve(): void {
		this.#approved = true;
	}

	/** `before-quit`: false while unapproved (veto it and ask); otherwise tears down once and lets it through. */
	proceed(teardown: () => void): boolean {
		if (!this.#approved) return false;
		if (!this.#tornDown) {
			this.#tornDown = true;
			teardown();
		}
		return true;
	}

	/**
	 * `before-quit-for-update`: the updater confirmed before `quitAndInstall()`,
	 * which closes every window before `before-quit` fires. Tearing down here
	 * runs ⌘Q's teardown while the windows and their tabs are still alive.
	 */
	proceedForUpdate(teardown: () => void): void {
		this.approve();
		this.proceed(teardown);
	}
}
