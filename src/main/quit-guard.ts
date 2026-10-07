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

/** Idle tabs die quietly; live agent runs always ask first. */
export function quitNeedsConfirmation(risk: QuitRisk): boolean {
	return risk.workingTabs > 0;
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
