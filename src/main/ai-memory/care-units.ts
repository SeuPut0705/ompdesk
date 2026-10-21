/**
 * The units memory care runs (care.ts), each over the modules that do the work:
 *
 * - `backfill` (backfill.ts): session conclusions for the turns before the server captured them, from omp's own
 *   journals. Runs a budget at a time until it is through, again after an update; never on a schedule (turns since
 *   are captured live).
 * - `curate` (curate.ts): durable pages that repeat or contradict each other, judged by Jev, else the cheap model
 *   (only while "Learn from conversations" is on: it reads stored pages to a provider), else the code rule. Daily.
 * - `fresh` (freshness.ts): decisions, gotchas and procedures naming repository files or symbols that are gone. Daily.
 */
import type { AiMemoryProjectRef } from "../../shared/ai-memory";
import { backfillConclusions } from "./backfill";
import type { CareClient, CareUnit } from "./care";
import type { AiMemoryClient } from "./client";
import { curateMemory, projectRules } from "./curate";
import { checkFreshness } from "./freshness";
import type { PairJudge } from "./memory-judge";

const DAY_MS = 24 * 60 * 60_000;

export type CareUnitsClient = Pick<
	AiMemoryClient,
	"projects" | "sessions" | "pages" | "page" | "conclusions" | "writeConclusions"
>;

export interface CareUnitsDeps {
	client: CareUnitsClient;
	/** Jev, else the cheap model, per run (memory-judge.ts `chainJudges`); null: the code rule alone. */
	judge: () => PairJudge | null;
	sessionsDir: string;
	readMessages: (path: string) => Promise<readonly unknown[]>;
	/** This computer's device id: the origin backfilled conclusions are written under (sync.ts `selfId`). */
	origin: () => string;
	log: (message: string, details: Record<string, string | number | boolean | null>) => void;
}

/** The reads of the real client, the page changes through care's recording one. */
function mixed(deps: CareUnitsDeps, care: CareClient) {
	const { client } = deps;
	return {
		projects: () => client.projects(),
		sessions: (project: AiMemoryProjectRef, limit?: number, offset?: number) =>
			client.sessions(project, limit, offset),
		pages: (project: AiMemoryProjectRef) => client.pages(project),
		page: (ref: AiMemoryProjectRef & { path: string }) => client.page(ref),
		retirePage: care.retirePage,
		feedback: care.feedback,
	};
}

const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function careUnits(deps: CareUnitsDeps): CareUnit[] {
	return [
		{
			name: "backfill",
			everyMs: null,
			run: async (_care, memo) => {
				const report = await backfillConclusions({
					client: deps.client,
					sessionsDir: deps.sessionsDir,
					readMessages: deps.readMessages,
					origin: deps.origin(),
					memo,
					log: deps.log,
				});
				return { done: report.remaining === 0 && !report.failed, written: report.written };
			},
		},
		{
			name: "curate",
			everyMs: DAY_MS,
			run: async (care, memo) => {
				const client = mixed(deps, care);
				const report = await curateMemory({
					client,
					judge: deps.judge(),
					rules: projectRules(client),
					log: deps.log,
					skip: new Set(strings(memo.unrelated)),
				});
				// Pairs judged unrelated stay settled until one of the two pages changes (the key holds both versions).
				memo.unrelated = [...new Set([...strings(memo.unrelated), ...report.unrelated])].slice(-2000);
				return { done: true };
			},
		},
		{
			name: "fresh",
			everyMs: DAY_MS,
			run: async (care, memo) => {
				const client = mixed(deps, care);
				const flagged = (memo.flagged && typeof memo.flagged === "object" ? memo.flagged : {}) as Record<
					string,
					string
				>;
				memo.flagged = flagged;
				for (const project of await client.projects()) {
					// One project the server cannot read never keeps the others from being checked.
					await checkFreshness({ client, project, log: deps.log, flagged }).catch((error: unknown) =>
						deps.log("care-skipped", {
							unit: "fresh",
							project: `${project.workspace}/${project.project}`,
							detail: error instanceof Error ? error.message : String(error),
						}),
					);
				}
				return { done: true };
			},
		},
	];
}
