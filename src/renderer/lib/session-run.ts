/**
 * What a session is doing, from the summary of the computer that runs it (`shared/session-summary.ts`): the one rule
 * every surface that shows a session's run reads (a sidebar row and a folded header, the title bar and the window
 * title, the tray, a split pane's header, the Work tree), on a desktop window, a paired computer's view and a phone
 * page alike. A surface never derives it from the tab events its own window happened to receive. Pure.
 */
import type { SessionSummary } from "../../shared/session-summary";
import type { AskKind } from "./attention";
import { isSessionDown, isTabFailed, type TabSignalPresentation, tabSignalPresentation } from "./tab-signal";

/** The facts of a summary the rule reads (a tab with no session file yet has these too). */
export type RunFacts = Pick<
	SessionSummary,
	"status" | "ask" | "settling" | "compacting" | "awaitingConnection" | "sessionHeld" | "queued" | "failure"
>;

export interface SessionRun {
	/** The token and words of its state; null with no summary. */
	signal: TabSignalPresentation | null;
	/** Its omp is not up: connecting, restarting, failed, exited, held. */
	down: boolean;
	/** Its own prompt, which only the person can answer. */
	ask: AskKind | undefined;
	waiting: boolean;
	/** A turn, background work after one, or a compaction runs (not while it waits). */
	running: boolean;
	/** Of `running`: the turn ended and only background work runs. */
	settling: boolean;
	failed: boolean;
	/** A finish nobody in this view looked at yet. */
	done: boolean;
	reason: string | undefined;
}

/**
 * A session's run: its own prompt first (none while the session is down), then its work (a turn, background work
 * after one, a compaction), then a failure. `unreadDone` is the view's own mark of a finish nobody here looked at yet.
 * `failed`: its omp failed (an `error` that is no held session); `reason` says why, as the computer running it said.
 * No summary yet (the computer has not said): nothing at all.
 */
export function sessionRun(facts: RunFacts | undefined, unreadDone = false): SessionRun {
	const signal = facts
		? tabSignalPresentation({
				status: facts.status,
				compacting: facts.compacting === true,
				awaitingInput: facts.ask,
				awaitingConnection: facts.awaitingConnection === true,
				...(facts.sessionHeld ? { sessionHeld: true as const } : {}),
				...(facts.queued ? { queued: true as const } : {}),
				unreadDone,
			})
		: null;
	const down = facts ? isSessionDown(facts) : false;
	const ask: AskKind | undefined =
		down || !facts?.ask ? undefined : facts.ask === "approval" ? "approval" : "question";
	const waiting = ask !== undefined;
	const running = !waiting && (facts?.status === "running" || facts?.compacting === true);
	const settling = running && facts?.status === "running" && facts.settling === true;
	const failed = facts ? isTabFailed(facts) : false;
	const done = !waiting && !running && signal?.labelKey === "tabs.done";
	const reason = down && !facts?.sessionHeld ? facts?.failure?.message : undefined;
	return { signal, down, ask, waiting, running, settling, failed, done, reason };
}
