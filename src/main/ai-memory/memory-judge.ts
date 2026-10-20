/**
 * The judge behind memory curation (`curate.ts`): are two durable pages a duplicate, does the newer one make the older
 * wrong, or are they about different things? Two model paths, each answering the whole batch, and the caller's code
 * rules when neither does:
 * - Jev (stock's native judge, cheap): a one-shot `omp --mode rpc -e resources/gui-bridge/memory-judge-host.ts` in an
 *   empty folder asks stock's own `judge` role chain, only while `hasNativeJudge` says it resolves to a native model.
 *   No native judge, a switched-off pref (`OMP_GUI_JUDGE_ASSIST=0`), an error or an unreadable answer → `null`.
 * - The cheap model (`distill-model.ts runSmol`): ONE batched call for all pairs, a JSON answer parsed strictly.
 * A verdict is only ever the model's word for a pair it was shown; anything it left unreadable is `null` for that pair.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OmpRuntime } from "../local/types";
import { OMP_TELEMETRY_OFF, ompPathEnv } from "../omp-runtime";
import { spawnPath } from "../shell-env";
import { needsShell, spawnArgs, spawnCommand } from "../spawn";
import type { DistillMessage } from "./distill";
import type { ModelResult } from "./distill-model";

/** A durable page as a judge reads it. */
export interface PageDigest {
	path: string;
	title: string;
	kind: string;
	/** `YYYY-MM-DD` of its last change. */
	saved: string;
	/** Where it lives: one project's page, or the owner's `_global` page. */
	scope: "project" | "global";
	/** The body without its H1 and its `_Source:` line, cut to `PAGE_CHARS`. */
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
export const RELATIONS: readonly Relation[] = ["duplicate", "a_outdated", "b_outdated", "unrelated"];

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
 * current: with it 11 of 11 seeded retirements in five runs, without it 11 of 11 in one of four (the others missed the
 * one stale pairing-code page). Jev does not take it: 11 of 11 either way, and about four times the input
 * (≈ $0.004 against $0.001 for 30 pairs). Never throws; null = did not decide.
 */
export type PairJudge = (pairs: readonly PagePair[], rules: string) => Promise<PairJudgment | null>;

/** A page is read up to this long: enough to tell a changed fact from a neighbour's. */
export const PAGE_CHARS = 600;

/** The probability Jev's top relation needs before it is a verdict (measured: see AGENTS.md "Memory curation"). */
export const JEV_MIN_CONFIDENCE = 0.6;

export const JEV_PURPOSE = "ompdesk-memory-curate";
const JEV_TIMEOUT_MS = 25_000;
const JEV_CONCURRENCY = 4;
const JEV_RUN_TIMEOUT_MS = 180_000;
const HOST_POLL_MS = 100;

/** The page body whole: no H1 (the title is shown), no `_Source:` line, whitespace folded. */
export function bodyText(markdown: string): string {
	return markdown
		.replace(/^# .*\n+/, "")
		.replace(/\n*_Source:[^\n]*\s*$/, "")
		.replaceAll(/\s+/g, " ")
		.trim();
}

/** The page body as a judge reads it: the whole body cut at {@link PAGE_CHARS}. */
export function pageText(markdown: string): string {
	return bodyText(markdown).slice(0, PAGE_CHARS);
}

const QUESTION = {
	type: "choice",
	instructions:
		"Two notes from the same person's memory about their software project: noteA is older, noteB is newer. Do they say the same thing, or does one of them make the other wrong to follow now? Choose duplicate only when they state the same decision or rule in other words. Choose A_outdated only when both answer the same question and noteB's answer replaces noteA's, so following noteA would now be a mistake. Choose B_outdated only when they conflict the same way but noteA is the current one. Notes about the same topic that state different facts, different layers or different rules, and that can all be true together, are unrelated, even when they share many words.",
	criteria: {
		unrelated: "Different facts or rules; both can be true; or you are not sure",
		duplicate: "The same decision or rule, said differently",
		A_outdated: "They conflict on one point and noteB is the current one",
		B_outdated: "They conflict on one point and noteA is the current one",
	},
} as const;

const JEV_RELATION: Record<string, Relation> = {
	unrelated: "unrelated",
	duplicate: "duplicate",
	A_outdated: "a_outdated",
	B_outdated: "b_outdated",
};

function noteOf(page: PageDigest) {
	return { title: page.title, kind: page.kind, saved: page.saved, scope: page.scope, text: page.text };
}

/** One judgment per pair: the same request twice is one cached answer. */
export function jevRequest(pair: PagePair) {
	return {
		state: {
			noteA: noteOf(pair.a),
			noteB: noteOf(pair.b),
		},
		questions: { relation: QUESTION },
	};
}

/** `value[key]` when `value` is an object holding it. */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

/** The verdict in a judgment's `answers`, or null (not a choice answer, an unknown option, under the bar). */
export function jevVerdict(answers: unknown): PairVerdict | null {
	const answer = field(answers, "relation");
	const choice = field(answer, "choice");
	if (typeof choice !== "string") return null;
	const relation = Object.hasOwn(JEV_RELATION, choice) ? JEV_RELATION[choice] : undefined;
	const probability = field(field(answer, "probabilities"), choice);
	if (!relation || typeof probability !== "number" || !Number.isFinite(probability)) return null;
	return probability >= JEV_MIN_CONFIDENCE ? { relation, confidence: probability } : null;
}

interface HostOutput {
	available?: boolean;
	error?: string;
	results?: { id: string; answers: unknown; ms: number }[];
	usage?: { model?: string; usage?: { cost?: { total?: number } } }[];
}

/**
 * Runs the host omp until it has written `done` (or exits, or the time is up) and then stops it. Its stdin stays open
 * on purpose: omp's RPC mode quits on end of input, before the judgments finish, and `OmpRuntime.run` closes stdin at
 * once. The host writes the answers atomically, so the file's existence means it is whole.
 */
async function runHost(
	bin: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
	done: string,
): Promise<void> {
	const basePath = await spawnPath();
	const child = spawn(spawnCommand(bin), spawnArgs(bin, args), {
		cwd,
		env: { ...process.env, ...env, PATH: ompPathEnv(bin, basePath), ...OMP_TELEMETRY_OFF },
		shell: needsShell(bin),
		stdio: ["pipe", "ignore", "ignore"],
		windowsHide: true,
	});
	let closed = false;
	child.on("close", () => {
		closed = true;
	});
	child.on("error", () => {
		closed = true;
	});
	const deadline = Date.now() + JEV_RUN_TIMEOUT_MS;
	try {
		while (!closed && !existsSync(done) && Date.now() < deadline) await sleep(HOST_POLL_MS);
	} finally {
		child.kill();
	}
}

export interface JevJudgeDeps {
	omp: Pick<OmpRuntime, "bin">;
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
		const started = performance.now();
		const dir = await mkdtemp(join(tmpdir(), "ompdesk-memory-judge-"));
		try {
			const input = join(dir, "in.json");
			const output = join(dir, "out.json");
			await writeFile(
				input,
				JSON.stringify({
					requests: pairs.map((pair, index) => ({ id: String(index), request: jevRequest(pair) })),
					timeoutMs: JEV_TIMEOUT_MS,
					concurrency: JEV_CONCURRENCY,
				}),
			);
			await runHost(
				deps.omp.bin,
				["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", deps.hostFile],
				deps.cwd,
				{ OMP_GUI_MEMORY_JUDGE_IN: input, OMP_GUI_MEMORY_JUDGE_OUT: output, OMP_GUI_JUDGE_ASSIST: "1" },
				output,
			);
			const out = JSON.parse(await readFile(output, "utf8")) as HostOutput;
			if (!out.available || !out.results) return null;
			const verdicts: (PairVerdict | null)[] = pairs.map(() => null);
			for (const result of out.results) verdicts[Number(result.id)] = jevVerdict(result.answers);
			if (verdicts.every(verdict => verdict === null)) return null;
			const cost = (out.usage ?? []).reduce((sum, entry) => sum + (entry.usage?.cost?.total ?? 0), 0);
			return {
				by: "jev",
				verdicts,
				model: [...new Set((out.usage ?? []).map(entry => entry.model).filter(Boolean))].join(",") || "jev",
				costUsd: cost,
				ms: Math.round(performance.now() - started),
			};
		} catch {
			return null;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	};
}

const SMOL_SYSTEM = `You compare notes from one person's memory about their software project. Each pair has an older note A and a newer note B. For every pair, say how they relate:
- "duplicate": they state the same decision or rule in other words; dropping one loses nothing.
- "a_outdated": both answer the same question and B's answer replaces A's, so following A would now be a mistake.
- "b_outdated": the same, but the OLDER note A is the current one.
- "unrelated": different facts, layers or rules that can all be true at once, even when they share many words (a rule for pushing and a rule for merging; a version pin and a rule about working without it; a project override of a general default).
When you are not sure, say "unrelated". A page that is only on the same topic is unrelated. Answer with JSON only, one object, no prose:
{"pairs":[{"id":"p1","relation":"duplicate"}]}
Give exactly one entry per pair, with the id it was shown under.`;

/** The batched message for every pair, shown as `p1`, `p2`, …; the rules-file outline (when any) is what is current. */
export function smolMessage(pairs: readonly PagePair[], rules: string): DistillMessage {
	const note = (label: string, page: PageDigest) =>
		`  ${label} (${page.saved}, ${page.scope === "global" ? "owner's general note" : "this project"}): ${page.title} — ${page.text}`;
	const blocks = pairs.map((pair, index) => `p${index + 1}\n${note("A", pair.a)}\n${note("B", pair.b)}`);
	const known = rules ? `What the project's rules file already says is current (outline):\n${rules}\n\n` : "";
	return { system: SMOL_SYSTEM, user: `${known}Pairs:\n\n${blocks.join("\n\n")}\n` };
}

/**
 * The model's answer as one verdict per pair. Strict: a single JSON object (optionally in one code fence) whose
 * `pairs` entries each carry a shown id and a known relation. An id shown twice, an unknown id or relation, or any
 * other shape leaves that pair `null`; text that is not JSON leaves them all `null`.
 */
export function parseSmolVerdicts(answer: string, count: number): (PairVerdict | null)[] {
	const verdicts: (PairVerdict | null)[] = Array.from({ length: count }, () => null);
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(answer.trim());
	let root: unknown;
	try {
		root = JSON.parse(fenced ? (fenced[1] ?? "") : answer.trim());
	} catch {
		return verdicts;
	}
	const entries = field(root, "pairs");
	if (!Array.isArray(entries)) return verdicts;
	const seen = new Set<number>();
	const bad = new Set<number>();
	for (const entry of entries) {
		const id = field(entry, "id");
		const relation = field(entry, "relation");
		const match = typeof id === "string" ? /^p(\d+)$/.exec(id) : null;
		const index = match ? Number(match[1]) - 1 : -1;
		if (index < 0 || index >= count) continue;
		if (seen.has(index)) bad.add(index);
		seen.add(index);
		const known = RELATIONS.find(candidate => candidate === relation);
		if (known) verdicts[index] = { relation: known, confidence: 1 };
	}
	for (const index of bad) verdicts[index] = null;
	return verdicts;
}

export interface SmolJudgeDeps {
	/** `distill-model.ts runSmol` on the user's omp (the upkeep's own `model` seam). */
	model: (message: DistillMessage) => Promise<ModelResult>;
}

/** One batched call on the cheap model; null when the call failed or answered nothing readable. */
export function smolJudge(deps: SmolJudgeDeps): PairJudge {
	return async (pairs, rules) => {
		if (pairs.length === 0) return null;
		const started = performance.now();
		try {
			const result = await deps.model(smolMessage(pairs, rules));
			const verdicts = parseSmolVerdicts(result.text, pairs.length);
			if (verdicts.every(verdict => verdict === null)) return null;
			return {
				by: "smol",
				verdicts,
				model: result.model,
				costUsd: result.costUsd,
				ms: Math.round(performance.now() - started),
			};
		} catch {
			return null;
		}
	};
}

/**
 * Judges in order of preference: the first that answers (Jev, else the cheap model) judges the whole batch. A pair the
 * answering judge leaves undecided is not passed on: measured, the cheap model asked about the one pair Jev left
 * (under its bar) cost $0.015 (the rules outline is most of its input) against $0.001 for Jev's 29 answers, and the
 * code rule retires only what it is sure of.
 */
export function chainJudges(...judges: PairJudge[]): PairJudge {
	return async (pairs, rules) => {
		for (const judge of judges) {
			const judgment = await judge(pairs, rules);
			if (judgment) return judgment;
		}
		return null;
	};
}
