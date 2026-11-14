/**
 * The "sessions are still working" inventory behind the ⌘Q confirmation. The rules that read it (when a quit asks,
 * the confirmations, the approval) are the shell's (`chrome_core::quit`); Node keeps this because only it knows the
 * tabs (`chrome-quit.ts` answers the shell's `chrome.quitFacts` with it, and `quitRisk()` quotes it inline).
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
