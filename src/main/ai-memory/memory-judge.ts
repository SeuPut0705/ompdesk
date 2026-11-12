/**
 * The judge behind memory curation (`curate.ts`): are two durable pages a duplicate, does the newer one make the older
 * wrong, or are they about different things? Two model paths, each answering the whole batch, and the caller's code
 * rules when neither does. All of it is the core's (`native/ompdesk/crates/core/src/care/judge.rs`):
 * - Jev (stock's native judge, cheap): a one-shot `omp --mode rpc -e resources/gui-bridge/memory-judge-host.ts` in an
 *   empty folder asks stock's own `judge` role chain, only while `hasNativeJudge` says it resolves to a native model.
 *   No native judge, a switched-off pref (`OMP_GUI_JUDGE_ASSIST=0`), an error or an unreadable answer → `null`.
 * - The cheap model (`distill-model.ts`): ONE batched call for all pairs, a JSON answer parsed strictly.
 * A verdict is only ever the model's word for a pair it was shown; anything it left unreadable is `null` for that pair.
 * Production runs both through the care's `curate` unit, Jev first (the first that answers judges the batch); this file
 * is the typed client of each, for the tests: `jevJudge` and `smolJudge` make one core request per judgment.
 */
import { askOnly, modelAsk, ompLaunchOf, oneShot } from "./core-asks";
import type { DistillMessage, ModelResult } from "./distill-model";

/** A durable page as a judge reads it. */
export interface PageDigest {
	path: string;
	title: string;
	kind: string;
	/** `YYYY-MM-DD` of its last change. */
	saved: string;
	/** Where it lives: one project's page, or the owner's `_global` page. */
	scope: "project" | "global";
	/** The body without its H1 and its `_Source:` line, cut to 600 characters. */
	text: string;
}

/** Two pages that may say the same thing; `a` is the older one. */
export interface PagePair {
	a: PageDigest;
	b: PageDigest;
}

/**
 * - `duplicate`: the same decision or rule in other words; dropping one loses nothing.
 * - `a_outdated`: they answer one question and the newer page `b` makes `a` wrong to follow.
 * - `b_outdated`: the same, but the OLDER page `a` is the current one.
 * - `unrelated`: different facts, layers or rules that can all be true at once.
 */
export type Relation = "duplicate" | "a_outdated" | "b_outdated" | "unrelated";

export interface PairVerdict {
	relation: Relation;
	/** The judge's probability for that relation (Jev); 1 for a model's plain answer. */
	confidence: number;
}

export interface PairJudgment {
	by: "jev" | "smol";
	/** One entry per asked pair, in order; `null` when the judge gave none the code accepts. */
	verdicts: (PairVerdict | null)[];
	model: string;
	costUsd: number;
	ms: number;
}

/**
 * What `curate.ts` asks. `rules` is the project's rules-file outline (empty: none). The cheap model reads it as what is
 * current; Jev does not take it. Never throws; null = did not decide.
 */
export type PairJudge = (pairs: readonly PagePair[], rules: string) => Promise<PairJudgment | null>;

/** Jev's own limit is 180 s; the pairs' judgments run beside each other inside it. */
const JEV_TIMEOUT_MS = 200_000;
/** The core's 180 s limit on omp, and room for it to answer. */
const SMOL_TIMEOUT_MS = 190_000;

export interface JevJudgeDeps {
	omp: { bin: string };
	/** `resources/gui-bridge/memory-judge-host.ts`. */
	hostFile: string;
	/** Settings › Agent behavior's judge switch (`judgeAssistEnabled(prefs.judgeAssist)`), read per run. */
	enabled: () => boolean;
	/** An empty folder for omp to run in: a repository's would load its AGENTS.md. */
	cwd: string;
}

/** Jev through stock's judge chain; null when there is no native judge or the run failed. */
export function jevJudge(deps: JevJudgeDeps): PairJudge {
	return async pairs => {
		if (!deps.enabled() || pairs.length === 0) return null;
		const side = askOnly({ omp: () => ompLaunchOf(deps.omp.bin) });
		return await oneShot<PairJudgment | null>(
			"care.judgeJev",
			side,
			{ pairs, enabled: true, hostFile: deps.hostFile, cwd: deps.cwd },
			{ timeoutMs: JEV_TIMEOUT_MS },
		);
	};
}

export interface SmolJudgeDeps {
	/** `distill-model.ts runSmol` on the user's omp (the upkeep's own `model` seam). */
	model: (message: DistillMessage) => Promise<ModelResult>;
}

/** One batched call on the cheap model; null when the call failed or answered nothing readable. */
export function smolJudge(deps: SmolJudgeDeps): PairJudge {
	return async (pairs, rules) => {
		if (pairs.length === 0) return null;
		const side = askOnly({ model: modelAsk(deps.model) });
		return await oneShot<PairJudgment | null>(
			"care.judgeSmol",
			side,
			{ pairs, rules, cwd: "" },
			{ timeoutMs: SMOL_TIMEOUT_MS },
		);
	};
}
