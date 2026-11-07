/**
 * What a session row shows of a session's run, from the summary of the computer that runs it
 * (`shared/session-summary.ts`): the one rule this computer's rows, a paired host's rows, a family row, the bot's row
 * and every folded header read, on a desktop window, a paired computer's view and a phone page alike. Pure.
 */
import type { RemoteOpenedTab } from "../../../../shared/ipc-types";
import type { SessionSummary } from "../../../../shared/session-summary";
import type { AskKind } from "../../../lib/attention";
import { isSessionDown, tabSignalPresentation } from "../../../lib/tab-signal";
import type { SessionTab } from "../../../stores/tabs";
import { type FoldSignal, type FoldSummary, foldSummary, sessionFoldSignal } from "./fold-summary";

/** The facts of a summary a row reads (a tab with no session file yet has these too, and no summary). */
export type RowFacts = Pick<
	SessionSummary,
	"status" | "ask" | "settling" | "awaitingConnection" | "sessionHeld" | "failure"
>;

/**
 * A row's run state: its own prompt first (none while the session is down), then its run. `unreadDone` is this
 * view's own mark of a finish nobody here looked at yet (a host's row has none). `fold` is what a folded header counts.
 * `reason`: why its omp failed, exited or restarts, as the computer running it said (a wait for the session has none).
 */
export function summaryRowState(facts: RowFacts | undefined, unreadDone = false) {
	const signal = facts
		? tabSignalPresentation({
				status: facts.status,
				awaitingInput: facts.ask,
				awaitingConnection: facts.awaitingConnection === true,
				...(facts.sessionHeld ? { sessionHeld: true as const } : {}),
				unreadDone,
			})
		: null;
	const down = facts ? isSessionDown(facts) : false;
	const ask: AskKind | undefined =
		down || !facts?.ask ? undefined : facts.ask === "approval" ? "approval" : "question";
	const waiting = ask !== undefined;
	const running = !waiting && facts?.status === "running";
	const settling = running && facts?.settling === true;
	const done = !waiting && !running && signal?.labelKey === "tabs.done";
	const fold = sessionFoldSignal({ waiting: ask, running, done });
	const reason = down && !facts?.sessionHeld ? facts?.failure?.message : undefined;
	return { signal, down, ask, waiting, running, settling, done, fold, reason };
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
 * each session once, by the rows' rule. A session a session here opened there is that opener's child (`nested`),
 * counted in this computer's section.
 */
export function hostSectionSummary(
	summaries: readonly SessionSummary[],
	nested: ReadonlySet<string> | undefined,
): FoldSummary {
	const signals: (FoldSignal | null)[] = [];
	for (const summary of summaries) if (!nested?.has(summary.sessionPath)) signals.push(summaryRowState(summary).fold);
	return foldSummary(signals);
}
