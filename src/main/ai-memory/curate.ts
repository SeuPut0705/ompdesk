/**
 * Memory curation: durable pages that repeat or contradict each other leave default recall, the older one first.
 * Recall answered a pairing question from a page that still said "enter the 8-digit pairing code" beside the newer
 * one that removed it, and the model read both. Nothing is deleted: the loser goes through `AiMemoryClient.retirePage`
 * (expired, synced, restorable), and a pinned page is never touched.
 *
 * 1. Every durable page (`isDurablePath`: decisions, _rules, gotchas, procedures, preferences, profile) of every
 *    project, with its body, through the client.
 * 2. Candidate pairs, cheaply: the same project, or a project and its workspace's `_global`; weighted term cosine
 *    over title and body (`rules-file.ts contentTerms`), each page's closest neighbours above a floor, best first,
 *    at most `maxPairs` a run, never a pair an earlier run already found unrelated (`skip`).
 * 3. A judge (`memory-judge.ts`: Jev, else the cheap model, one batched call) says duplicate / the newer makes the
 *    older wrong / the older is current / unrelated. A pair it left undecided is judged by the code rule, which only
 *    ever retires a near-identical copy.
 * 4. The loser retires with the winner named as its successor, conditional on the version that was judged.
 *    A duplicate keeps the newer page (across a project and `_global` the project copy goes: the general one still
 *    applies there); a contradiction is retired only inside one project (a project's page that differs from a general
 *    preference is an override, not a stale copy).
 * Idempotent: a retired page is hidden from the page list, so it is never a candidate again.
 */
import type { AiMemoryPage, AiMemoryPageRef, AiMemoryProjectRef } from "../../shared/ai-memory";
import { isDurablePath } from "../remote/app-protocol";
import type { AiMemoryClient } from "./client";
import { GLOBAL_PROJECT } from "./distill";
import { type PageDigest, type PagePair, type PairJudge, type PairVerdict, pageText } from "./memory-judge";
import { contentTerms, readRulesText, rulesOutline } from "./rules-file";

export type CurateClient = Pick<AiMemoryClient, "projects" | "pages" | "page" | "retirePage">;

export type CurateLogDetails = Record<string, string | number | boolean | null>;

/** Pairs judged in one run: bounds the model cost; the rest follow in later runs. */
export const CURATE_MAX_PAIRS = 30;
/** A page is compared with its closest few; a pair needs at least this weighted cosine to be a candidate. */
export const CANDIDATE_NEIGHBOURS = 3;
export const CANDIDATE_FLOOR = 0.1;
/** The code rule retires a copy only when title and body share at least this fraction of their terms. */
export const NEAR_IDENTICAL = 0.8;
/** Durable pages read per project, newest first. */
export const CURATE_MAX_PAGES = 400;
const READ_BATCH = 8;

export interface CurateDeps {
	client: CurateClient;
	/** Jev, else the cheap model (`memory-judge.ts`); absent: the code rule alone. */
	judge?: PairJudge | null;
	/** The rules-file outline of a project's repository (`rules-file.ts`), what the judge may treat as current. */
	rules?: (project: AiMemoryProjectRef) => Promise<string>;
	/** One line per retire and one for the run, message `care-curate`. */
	log: (message: "care-curate", details: CurateLogDetails) => void;
	/** Report what would retire; write and log nothing about pages. */
	dryRun?: boolean;
	maxPairs?: number;
	/** `pairKey`s an earlier run judged unrelated (the caller keeps them: `CurateReport.unrelated`). */
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

interface CuratePage {
	ref: AiMemoryPageRef;
	page: AiMemoryPage;
	global: boolean;
	terms: Set<string>;
	norm: number;
}

/** A pair's identity: both pages at the versions that were compared, order-free. */
export function pairKey(a: Pick<AiMemoryPage, "workspace" | "project" | "path" | "id">, b: typeof a): string {
	return [a, b]
		.map(page => `${page.workspace}/${page.project}/${page.path}@${page.id}`)
		.sort()
		.join("|");
}

const pageKey = (page: AiMemoryPage) => `${page.workspace}/${page.project}/${page.path}`;

function termsOf(page: AiMemoryPage): Set<string> {
	return contentTerms(`${page.title}\n${page.title}\n${pageText(page.markdown)}`);
}

async function readInBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R | null>): Promise<R[]> {
	const out: R[] = [];
	for (let at = 0; at < items.length; at += READ_BATCH) {
		const batch = await Promise.all(items.slice(at, at + READ_BATCH).map(read));
		for (const item of batch) if (item) out.push(item);
	}
	return out;
}

/** The durable pages of every project, read whole; a page that cannot be read is left out. */
async function loadPages(client: CurateClient): Promise<{ pages: CuratePage[]; projects: number }> {
	const projects = await client.projects();
	let counted = 0;
	const pages: CuratePage[] = [];
	for (const project of projects) {
		const refs = (await client.pages(project)).filter(ref => isDurablePath(ref.path)).slice(0, CURATE_MAX_PAGES);
		if (refs.length === 0) continue;
		counted++;
		const read = await readInBatches(refs, async ref => {
			try {
				return { ref, page: await client.page(ref) };
			} catch {
				return null;
			}
		});
		for (const { ref, page } of read) {
			const terms = termsOf(page);
			pages.push({ ref, page, global: project.project === GLOBAL_PROJECT.project, terms, norm: 0 });
		}
	}
	return { pages, projects: counted };
}

interface Candidate {
	a: CuratePage;
	b: CuratePage;
	score: number;
}

/** Weighted term cosine of every allowed pair, each page's closest `CANDIDATE_NEIGHBOURS` above the floor, best first. */
export function candidatePairs(all: CuratePage[]): Candidate[] {
	const df = new Map<string, number>();
	for (const page of all) for (const term of page.terms) df.set(term, (df.get(term) ?? 0) + 1);
	const weight = (term: string) => Math.log(1 + all.length / (df.get(term) ?? 1));
	for (const page of all) {
		let sum = 0;
		for (const term of page.terms) sum += weight(term) ** 2;
		page.norm = Math.sqrt(sum);
	}
	const scored = new Map<CuratePage, Candidate[]>();
	const pairs: Candidate[] = [];
	for (let i = 0; i < all.length; i++) {
		for (let j = i + 1; j < all.length; j++) {
			const first = all[i];
			const second = all[j];
			if (!first || !second) continue;
			if (first.page.workspace !== second.page.workspace) continue;
			if (first.page.project !== second.page.project && !first.global && !second.global) continue;
			let dot = 0;
			for (const term of first.terms) if (second.terms.has(term)) dot += weight(term) ** 2;
			const score = dot / (first.norm * second.norm || 1);
			if (score < CANDIDATE_FLOOR) continue;
			const [a, b] = olderFirst(first, second);
			const pair = { a, b, score };
			pairs.push(pair);
			for (const page of [first, second]) {
				const list = scored.get(page) ?? [];
				list.push(pair);
				scored.set(page, list);
			}
		}
	}
	const keep = new Set<Candidate>();
	for (const list of scored.values()) {
		for (const pair of list.sort((x, y) => y.score - x.score).slice(0, CANDIDATE_NEIGHBOURS)) keep.add(pair);
	}
	return pairs.filter(pair => keep.has(pair)).sort((x, y) => y.score - x.score);
}

function olderFirst(x: CuratePage, y: CuratePage): [CuratePage, CuratePage] {
	const byTime = (x.page.updatedAt ?? "").localeCompare(y.page.updatedAt ?? "");
	return (byTime || pageKey(x.page).localeCompare(pageKey(y.page))) <= 0 ? [x, y] : [y, x];
}

function digest(page: CuratePage): PageDigest {
	return {
		path: page.page.path,
		title: page.page.title,
		kind: page.page.kind ?? "",
		saved: (page.page.updatedAt ?? "").slice(0, 10),
		scope: page.global ? "global" : "project",
		text: pageText(page.page.markdown),
	};
}

/** Title and body terms they share, of all they hold (Jaccard). */
function overlap(a: Set<string>, b: Set<string>): number {
	let shared = 0;
	for (const term of a) if (b.has(term)) shared++;
	return shared / (a.size + b.size - shared || 1);
}

/** The code rule: only a near-identical copy is a duplicate; it never calls a contradiction. */
function codeVerdict(pair: Candidate): PairVerdict | null {
	const similarity = overlap(pair.a.terms, pair.b.terms);
	return similarity >= NEAR_IDENTICAL ? { relation: "duplicate", confidence: similarity } : null;
}

interface Decision {
	loser: CuratePage;
	winner: CuratePage;
	relation: Retirement["relation"];
	by: CurateBy;
	confidence: number;
	score: number;
}

/** Who goes, or null: unrelated, or a contradiction between a project and its `_global`. */
function decide(pair: Candidate, verdict: PairVerdict, by: CurateBy): Decision | null {
	const base = { by, confidence: verdict.confidence, score: pair.score };
	const cross = pair.a.global !== pair.b.global;
	switch (verdict.relation) {
		case "duplicate": {
			const [loser, winner] =
				cross && pair.b.global ? [pair.a, pair.b] : cross ? [pair.b, pair.a] : [pair.a, pair.b];
			return { ...base, loser, winner, relation: "duplicate" };
		}
		case "a_outdated":
			return cross ? null : { ...base, loser: pair.a, winner: pair.b, relation: "a_outdated" };
		case "b_outdated":
			return cross ? null : { ...base, loser: pair.b, winner: pair.a, relation: "b_outdated" };
		default:
			return null;
	}
}

/** Pairs grouped by the project whose rules file the judge is shown (a `_global` pair has none). */
function groupByProject(pairs: Candidate[]): Map<string, Candidate[]> {
	const groups = new Map<string, Candidate[]>();
	for (const pair of pairs) {
		const owner = pair.a.global ? pair.b : pair.a;
		const key = owner.global ? "" : `${owner.page.workspace}\u0000${owner.page.project}`;
		groups.set(key, [...(groups.get(key) ?? []), pair]);
	}
	return groups;
}

/**
 * `CurateDeps.rules` from the client: the outline of the rules files at the root of the repository the project's
 * newest session ran in (the folder upkeep's learn step reads the same way); empty for `_global` or no such folder.
 */
export function projectRules(
	client: Pick<AiMemoryClient, "sessions">,
	read: (cwd: string) => Promise<string> = readRulesText,
): (project: AiMemoryProjectRef) => Promise<string> {
	return async project => {
		const cwd = (await client.sessions(project, 20)).find(session => session.cwd)?.cwd ?? "";
		return rulesOutline(await read(cwd));
	};
}

export async function curateMemory(deps: CurateDeps): Promise<CurateReport> {
	const started = performance.now();
	const dryRun = deps.dryRun === true;
	const at = (deps.now ?? (() => new Date()))();
	const { pages, projects } = await loadPages(deps.client);
	const all = candidatePairs(pages);
	const skip = deps.skip ?? new Set<string>();
	const fresh = all.filter(pair => !skip.has(pairKey(pair.a.page, pair.b.page)));
	const asked = fresh.slice(0, deps.maxPairs ?? CURATE_MAX_PAIRS);
	const report: CurateReport = {
		dryRun,
		projects,
		pages: pages.length,
		candidates: all.length,
		judged: asked.length,
		retirements: [],
		unrelated: [],
		undecided: 0,
		by: { jev: 0, smol: 0, code: 0 },
		models: [],
		costUsd: 0,
		ms: 0,
	};

	const decisions: Decision[] = [];
	for (const [owner, group] of groupByProject(asked)) {
		const [workspace, project] = owner.split("\u0000");
		const rules =
			owner && deps.rules && project
				? await deps.rules({ workspace: workspace ?? "", project }).catch(() => "")
				: "";
		const judgment = deps.judge
			? await deps.judge(
					group.map((pair): PagePair => ({ a: digest(pair.a), b: digest(pair.b) })),
					rules,
				)
			: null;
		if (judgment) {
			report.costUsd += judgment.costUsd;
			if (!report.models.includes(judgment.model)) report.models.push(judgment.model);
		}
		group.forEach((pair, index) => {
			const modelVerdict = judgment?.verdicts[index] ?? null;
			const verdict = modelVerdict ?? codeVerdict(pair);
			const by: CurateBy = modelVerdict && judgment ? judgment.by : "code";
			if (!verdict) {
				report.undecided++;
				return;
			}
			report.by[by]++;
			const decision = decide(pair, verdict, by);
			if (decision) decisions.push(decision);
			else if (verdict.relation === "unrelated") report.unrelated.push(pairKey(pair.a.page, pair.b.page));
		});
	}

	// The surest verdicts first; a page already kept for one pair is never retired for another, nor one retired kept.
	const retired = new Set<string>();
	const kept = new Set<string>();
	for (const decision of decisions.sort((x, y) => y.confidence - x.confidence || y.score - x.score)) {
		const loserKey = pageKey(decision.loser.page);
		const winnerKey = pageKey(decision.winner.page);
		if (kept.has(loserKey) || retired.has(winnerKey) || retired.has(loserKey) || decision.loser.page.pinned) continue;
		retired.add(loserKey);
		kept.add(winnerKey);
		const { loser, winner } = decision;
		const retirement: Retirement = {
			workspace: loser.page.workspace,
			project: loser.page.project,
			path: loser.page.path,
			title: loser.page.title,
			successor: `${winner.page.project}/${winner.page.path}`,
			relation: decision.relation,
			by: decision.by,
			confidence: Math.round(decision.confidence * 100) / 100,
			result: "planned",
		};
		if (!dryRun) {
			try {
				retirement.result = await deps.client.retirePage({
					workspace: loser.page.workspace,
					project: loser.page.project,
					path: loser.page.path,
					successor: winner.page.path,
					at,
					expectedPageId: loser.page.id,
				});
			} catch {
				retirement.result = "failed";
			}
			if (retirement.result === "retired") {
				deps.log("care-curate", {
					event: "retire",
					workspace: retirement.workspace,
					project: retirement.project,
					path: retirement.path,
					successor: retirement.successor,
					relation: retirement.relation,
					by: retirement.by,
					confidence: retirement.confidence,
				});
			}
		}
		report.retirements.push(retirement);
	}

	report.ms = Math.round(performance.now() - started);
	if (!dryRun) {
		deps.log("care-curate", {
			event: "run",
			projects: report.projects,
			pages: report.pages,
			candidates: report.candidates,
			judged: report.judged,
			retired: report.retirements.filter(item => item.result === "retired").length,
			skipped: report.retirements.filter(item => item.result !== "retired").length,
			unrelated: report.unrelated.length,
			undecided: report.undecided,
			jev: report.by.jev,
			smol: report.by.smol,
			code: report.by.code,
			models: report.models.join(","),
			costUsd: Math.round(report.costUsd * 1e6) / 1e6,
			ms: report.ms,
		});
	}
	return report;
}
