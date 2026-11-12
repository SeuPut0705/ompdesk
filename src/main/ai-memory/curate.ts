/**
 * Memory curation: durable pages that repeat or contradict each other leave default recall, the older one first.
 * Recall answered a pairing question from a page that still said "enter the 8-digit pairing code" beside the newer
 * one that removed it, and the model read both. Nothing is deleted: the loser goes through `AiMemoryClient.retirePage`
 * (expired, synced, restorable), and a pinned page is never touched. The run is the core's
 * (`native/ompdesk/crates/core/src/care/curate.rs`):
 *
 * 1. Every durable page (decisions, _rules, gotchas, procedures, preferences, profile) of every project, with its body.
 * 2. Candidate pairs, cheaply: the same project, or a project and its workspace's `_global`; weighted term cosine over
 *    title and body, each page's closest neighbours above a floor, best first, at most `maxPairs` a run, never a pair
 *    an earlier run already found unrelated (`skip`).
 * 3. A judge (`memory-judge.ts`: Jev, else the cheap model, one batched call) says duplicate / the newer makes the
 *    older wrong / the older is current / unrelated. A pair it left undecided is judged by the code rule, which only
 *    ever retires a near-identical copy.
 * 4. The loser retires with the winner named as its successor, conditional on the version that was judged. A
 *    duplicate keeps the newer page (across a project and `_global` the project copy goes: the general one still
 *    applies there); a contradiction is retired only inside one project.
 * Idempotent: a retired page is hidden from the page list, so it is never a candidate again.
 *
 * Production runs it as the care's `curate` unit (`care.ts`); this file is the typed client of one run, for the tests.
 */
import type { AiMemoryClient } from "./client";
import { type AskHandler, coreSide, judgeAsk, oneShot, rulesAsk } from "./core-asks";
import type { PairJudge } from "./memory-judge";

/** The client calls a run makes (`sessions` too when `rules` is given: the folder of a project's newest session). */
export type CurateClient = Pick<AiMemoryClient, "projects" | "pages" | "page" | "retirePage"> &
	Partial<Pick<AiMemoryClient, "sessions">>;

export type CurateLogDetails = Record<string, string | number | boolean | null>;

export interface CurateDeps {
	client: CurateClient;
	/** A test's judge (production's chain is the core's); absent: the code rule alone. */
	judge?: PairJudge | null;
	/**
	 * The rules files of the repository a folder is in (the core reads them itself otherwise). Given, the judge is shown
	 * each project's rules-file outline: the folder is the project's newest session's.
	 */
	rules?: (cwd: string) => Promise<string>;
	/** One line per retire and one for the run, message `care-curate`. */
	log: (message: "care-curate", details: CurateLogDetails) => void;
	/** Report what would retire; write and log nothing about pages. */
	dryRun?: boolean;
	maxPairs?: number;
	/** Pair keys an earlier run judged unrelated (the caller keeps them: `CurateReport.unrelated`). */
	skip?: ReadonlySet<string>;
	now?: () => Date;
}

export type CurateBy = "jev" | "smol" | "code";

export interface Retirement {
	workspace: string;
	project: string;
	path: string;
	title: string;
	/** The page kept, as `<project>/<path>`. */
	successor: string;
	relation: "duplicate" | "a_outdated" | "b_outdated";
	by: CurateBy;
	confidence: number;
	result: "retired" | "planned" | "pinned" | "changed" | "failed";
}

export interface CurateReport {
	dryRun: boolean;
	projects: number;
	pages: number;
	/** Candidate pairs found, before the cap and the skip list. */
	candidates: number;
	/** Pairs asked of a judge or the code rule. */
	judged: number;
	retirements: Retirement[];
	/** Pairs judged unrelated: remember them and pass them back as `skip`. */
	unrelated: string[];
	/** Pairs nobody decided (no judge, or it gave no readable verdict). */
	undecided: number;
	/** Who answered how many pairs. */
	by: Record<CurateBy, number>;
	/** The models that answered (a judge's own account of who billed). */
	models: string[];
	costUsd: number;
	ms: number;
}

/** Reading every durable page, a judge run (up to 360 s: Jev, then the cheap model) per project, and the retires. */
const RUN_TIMEOUT_MS = 1_800_000;

export async function curateMemory(deps: CurateDeps): Promise<CurateReport> {
	const answers: Record<string, AskHandler> = {};
	if (deps.judge) answers.judge = judgeAsk(deps.judge);
	if (deps.rules) answers.rules = rulesAsk(deps.rules);
	return await oneShot<CurateReport>(
		"care.curate",
		coreSide(deps.client, answers),
		{
			dryRun: deps.dryRun === true,
			projectRules: deps.rules !== undefined,
			skip: [...(deps.skip ?? [])],
			...(deps.maxPairs === undefined ? {} : { maxPairs: deps.maxPairs }),
			...(deps.now ? { now: deps.now().getTime() } : {}),
		},
		{
			timeoutMs: RUN_TIMEOUT_MS,
			log: (message, details) => {
				if (message === "care-curate") deps.log(message, details);
			},
		},
	);
}
