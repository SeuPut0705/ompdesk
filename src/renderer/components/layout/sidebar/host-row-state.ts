/**
 * What a session row shows of a session's run, from the summary of the computer that runs it
 * (`shared/session-summary.ts`) by the one rule every surface reads (`lib/session-run.ts`), plus what a folded header
 * counts of it. This computer's rows, a paired host's rows, a family row and every folded header read
 * it, on a desktop window, a paired computer's view and a phone page alike. Pure.
 */
import type { RemoteOpenedTab } from "../../../../shared/ipc-types";
import type { SessionSummary } from "../../../../shared/session-summary";
import { type RunFacts, type SessionRun, sessionRun } from "../../../lib/session-run";
import type { SessionTab } from "../../../stores/tabs";
import { type FoldSignal, type FoldSummary, foldSummary, sessionFoldSignal } from "./fold-summary";

/** A row's run state (`sessionRun`) and `fold`, what a folded header counts of it. */
export function summaryRowState(
	facts: RunFacts | undefined,
	unreadDone = false,
): SessionRun & { fold: FoldSignal | null } {
	const run = sessionRun(facts, unreadDone);
	return { ...run, fold: sessionFoldSignal({ waiting: run.ask, running: run.running, done: run.done }) };
}

/**
 * A stand-in for a tab another view of the computer holds on a paired device (`RemoteOpenedTab`): what the family
 * rule (`familyRows`) reads of it, as of the tab the holding window has.
 */
export function remoteOpenedTab(tab: RemoteOpenedTab): SessionTab {
	const { tabId, here: _here, ...facts } = tab;
	return { ...facts, id: tabId, unreadDone: false };
}

/**
 * A folded host section's summary, read without its list (a folded host's list is not read): the host's summaries,
 * each session once, by the rows' rule. A session a session here opened there is a row of both sections.
 */
export function hostSectionSummary(summaries: readonly SessionSummary[]): FoldSummary {
	return foldSummary(summaries.map(summary => summaryRowState(summary).fold));
}
