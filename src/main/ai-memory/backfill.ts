/**
 * Session conclusions for the turns that ended before the server captured them (it keeps a turn's last reply only from
 * 19 Oct 2026 21:49 UTC on), read back from omp's own journals. The pass is the core's
 * (`native/ompdesk/crates/core/src/care/backfill.rs`): which journals, which project each belongs to, which turns the
 * server already captured itself, what is written under this computer's device id (`backfill:<session>:<message ms>`,
 * so sync carries each copy to the paired computers exactly once), and the state (`memo.backfill`) that records the
 * journals a pass finished, keyed by the database id the server reports. The stock worker reads a journal
 * (`stock-helper/memory.ts journalFacts`); this file is the typed client of one pass, for the tests. Production runs the
 * pass as the care's `backfill` unit (`care.ts`).
 */
import type { AiMemoryClient } from "./client";
import { coreSide, factsAsk, journalAsk, oneShot } from "./core-asks";

/** The client calls a pass makes (a fake implements exactly these). */
export type BackfillClient = Pick<
	AiMemoryClient,
	"projects" | "sessions" | "pages" | "conclusions" | "writeConclusions"
>;

export interface BackfillDeps {
	client: BackfillClient;
	/** The stock sessions folder: `<cwd-slug>/<timestamp>_<id>.jsonl`, a subagent's at `<…>/<timestamp>_<id>/<n>-<Agent>.jsonl`. */
	sessionsDir: string;
	/** The messages along a journal's persisted leaf (`SessionIndex.readMessages`, stock `loadSessionMessagesReadOnly`). */
	readMessages(path: string): Promise<readonly unknown[]>;
	/** This computer's OMPdesk device id (sync.ts `selfId()`): the origin the copies are written under. */
	origin: string;
	/**
	 * Plain-JSON state the caller keeps between launches (care.json): the journals a pass finished, under the key
	 * `backfill`. The pass changes it in place from the core's answer; the caller persists it after the pass.
	 */
	memo: Record<string, unknown>;
	/** The one runtime-log line of a pass that read a journal: `care-backfill`. */
	log(message: string, details: Record<string, string | number | boolean | null>): void;
	/** The clock the core reads during the pass (a test drives it); the system's without it. */
	now?(): number;
	maxJournals?: number;
	maxRows?: number;
}

export interface BackfillReport {
	/** The database the state belongs to ("" from a server that does not say). */
	store: string;
	/** Conversation journals found (an advisor's `__advisor.jsonl` never counts). */
	journals: number;
	/** Finished in an earlier pass and unchanged since: not looked at. */
	done: number;
	/** Looked at this pass and mapped to a project, by the session id the server holds / by the folder. */
	mappedById: number;
	mappedByCwd: number;
	/** Skipped: no session header, the folder none of the server's sessions use, the folder two projects' sessions use. */
	noHeader: number;
	unmapped: number;
	ambiguous: number;
	/** A mapped journal stock could not read. */
	unreadable: number;
	/**
	 * Read but not copied: an agent wrote the first prompt (a subagent's assignment, another session's message) and it
	 * names no task with a `Title:` line.
	 */
	untitled: number;
	/** Journals read this pass, and the turns of them still to be written (not native, before the cutoff). */
	read: number;
	turns: number;
	written: number;
	same: number;
	/** Rows the server kept nothing of after its own scrubbing. */
	refused: number;
	/** Mapped journals still waiting for a later pass (the budget ended this one). */
	remaining: number;
	/** The server failed a write: the pass stopped, the journal is read again next time. */
	failed: boolean;
	ms: number;
}

/** A pass reads at most 300 journals; the core's own limits bound the rest. */
const PASS_TIMEOUT_MS = 600_000;

/**
 * One pass: map the journals not finished yet, read the server's own conclusions, and write the missing turns of as
 * many journals as the budget allows. Throws only when the server cannot be asked at all; a failed write ends the pass
 * with `failed: true`.
 */
export async function backfillConclusions(deps: BackfillDeps): Promise<BackfillReport> {
	const side = coreSide(deps.client, { journal: journalAsk(deps.readMessages), facts: factsAsk() });
	const answer = await oneShot<{ report: BackfillReport; memo: Record<string, unknown> }>(
		"care.backfill",
		side,
		{
			sessionsDir: deps.sessionsDir,
			origin: deps.origin,
			memo: deps.memo,
			...(deps.now ? { now: deps.now() } : {}),
			...(deps.maxJournals === undefined ? {} : { maxJournals: deps.maxJournals }),
			...(deps.maxRows === undefined ? {} : { maxRows: deps.maxRows }),
		},
		{ timeoutMs: PASS_TIMEOUT_MS, log: deps.log },
	);
	Object.assign(deps.memo, answer.memo);
	return answer.report;
}
