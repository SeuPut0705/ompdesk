/**
 * When a tab's held work ends: its connection wait, its reachability probe, its scheduled retry, and a continuation on
 * its way. One table: each row is something that ends a hold, named by the formal/turn-resume action that brings it
 * about; each column is a place the resume looks at a hold, named by the action that looks. `TurnResume` asks
 * {@link holdEnd} at every one of those places and decides there only what the end does (which rows and timers go).
 * A new end condition is one row here and one action in `formal/turn-resume/tla/TurnResume.tla`
 * (`turn-resume-ends.test.ts` holds the two in step).
 */
import type { IpcTabRunOutcome } from "../shared/ipc-types";
import type { ResumeFact } from "./turn-resume";

/** Where the resume looks at a hold, with the model action that looks. */
export const HOLD_CHECKS = {
	/** `sync()`: a connection wait that holds. */
	wait: "S_NewRun",
	/** `sync()`: a reachability probe still out. */
	probe: "S_NewRun",
	/** The probe answered. */
	probeAnswer: "VerifyThen",
	/** `sync()` on an armed scheduled retry; also whether one may be armed at all. */
	armed: "S_Watch",
	/** The scheduled retry's timer ran, before and after it asks stock's retry setting. */
	firing: "FireResume",
	/** A continuation on its way (a flush, a fired retry, a relaunch), before each command it sends. */
	continuing: "RunGo",
} as const;

export type HoldCheck = keyof typeof HOLD_CHECKS;

/** What a hold was taken for. */
export interface HeldFor {
	/** The tab's session file then; none for a first turn stock has not written yet. */
	sessionFile?: string | undefined;
	/** The tab's moves then (`ResumeFact.touched`). */
	touched: number;
	/** The person's prompts when a continuation started (`ResumeFact.prompted`; `continuing` only). */
	prompted?: number;
	/** The failed run the hold is for (a probe, a scheduled retry). */
	outcome?: IpcTabRunOutcome;
}

export interface HoldContext {
	/** A quit is underway. */
	frozen: boolean;
	/** The run on the tab is the hold's own: stock's retry saga a wait took over, or the scheduled retry's own run. */
	ownRun: boolean;
}

interface HoldEndRow {
	/** The formal/turn-resume actions that bring it about; `[]` for what the model keeps constant (SCOPE.md). */
	model: readonly string[];
	/** The places it ends a hold. */
	checks: readonly HoldCheck[];
	ends(fact: ResumeFact | undefined, since: HeldFor, context: HoldContext): boolean;
}

/**
 * The tab went to another session or branch since `since`: `touched` moved (a `TOUCH_COMMANDS` move), or the session
 * file recorded then is no longer the tab's. A file written later (a first turn stock had not saved yet) is the same
 * conversation, not a change.
 */
export function movedSince(fact: ResumeFact, since: HeldFor): boolean {
	if ((fact.touched ?? 0) !== since.touched) return true;
	return since.sessionFile !== undefined && fact.sessionFile !== since.sessionFile;
}

/**
 * The tab runs a run of the person's: not the failed run still ending (its outcome is set; background work can keep it
 * running), not stock's retry saga, and not `ownRun` (the hold's own run). It also starts a scheduled retry's chain over.
 */
export function personsRun(fact: ResumeFact, ownRun: boolean): boolean {
	return fact.running && !fact.lastRun && !fact.retry && !ownRun;
}

/**
 * Every end condition. The order is the precedence {@link holdEnd} reports, and only `continuing` acts on which one
 * it was: a move ends every hold of the tab, the person's prompt only that continuation.
 */
export const HOLD_ENDS = {
	/** The tab is closed. */
	gone: {
		model: [],
		checks: ["probeAnswer", "armed", "firing"],
		ends: fact => fact === undefined,
	},
	/** A quit tears the tabs down. */
	frozen: {
		model: [],
		checks: ["probeAnswer", "armed", "firing"],
		ends: (_fact, _since, context) => context.frozen,
	},
	/** A run that is none of the hold's own and not the failed one still ending: the person sent a new prompt. */
	personsRun: {
		model: ["UserPrompt"],
		checks: ["wait", "probe", "armed"],
		ends: (fact, _since, context) => fact !== undefined && personsRun(fact, context.ownRun),
	},
	/** The person pressed Stop. */
	stopped: {
		model: ["UserStop"],
		checks: ["probe", "probeAnswer", "armed", "firing"],
		ends: fact => fact?.stopped === true,
	},
	/** Another session or branch (`movedSince`). */
	moved: {
		model: ["MoveReply", "FileMoved"],
		checks: ["wait", "probeAnswer", "armed", "firing", "continuing"],
		ends: (fact, since) => fact !== undefined && movedSince(fact, since),
	},
	/** The person prompted since the continuation started: the run that began is theirs (A11). */
	personsPrompt: {
		model: ["UserPrompt"],
		checks: ["continuing"],
		ends: (fact, since) => (fact?.prompted ?? 0) !== (since.prompted ?? 0),
	},
	/**
	 * Stock wrote the first turn's file after the probe went out. Only the probe's answer counts it; a wait holds on
	 * (`movedSince`), and a retry is never armed without a file. The model has one file per session.
	 */
	fileWritten: {
		model: [],
		checks: ["probeAnswer"],
		ends: (fact, since) => since.sessionFile === undefined && fact?.sessionFile !== undefined,
	},
	/** The tab's last run is no longer the failure the hold is for: a run started or ended since. */
	otherOutcome: {
		model: ["UserPrompt", "EndRun", "RetryTaken"],
		checks: ["probeAnswer", "armed", "firing"],
		ends: (fact, since) => fact?.lastRun !== since.outcome,
	},
	/** The tab's retry is not this computer's to make, or the connection wait holds it. */
	notRetryable: {
		model: ["Launch", "S_Judge", "VerifyThen"],
		checks: ["armed", "firing"],
		ends: fact =>
			fact !== undefined &&
			(fact.peer !== undefined ||
				fact.device !== undefined ||
				fact.sessionFile === undefined ||
				fact.awaitingConnection),
	},
	/** The tab runs (the failed turn's background work, or any run): the timer leaves it alone. */
	busy: {
		model: ["UserPrompt", "EndRun", "RetryTaken"],
		checks: ["firing"],
		ends: fact => fact?.running === true,
	},
} as const satisfies Record<string, HoldEndRow>;

export type HoldEnd = keyof typeof HOLD_ENDS;

const ROWS = Object.entries(HOLD_ENDS) as Array<[HoldEnd, HoldEndRow]>;

/** What ends a hold `check` looks at, or null while it holds. */
export function holdEnd(
	check: HoldCheck,
	since: HeldFor,
	fact: ResumeFact | undefined,
	context: HoldContext,
): HoldEnd | null {
	for (const [end, row] of ROWS) if (row.checks.includes(check) && row.ends(fact, since, context)) return end;
	return null;
}
