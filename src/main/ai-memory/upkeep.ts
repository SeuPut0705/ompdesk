/**
 * What OMPdesk does for memory's quality once the server is up, with ai-memory's own write paths and nothing else:
 *
 * 1. **Repair, once per launch** (`retitle.ts`): session pages filed under protocol text get their task's name, and the
 *    handoffs a child session left are discarded. Idempotent, so a launch with nothing to repair does two reads.
 * 2. **Learn** (`distill.ts`): ai-memory writes session pages by itself but no decisions, rules or gotchas (its own
 *    consolidation needs an LLM provider on the server, which OMPdesk keeps out). While Settings › Memory › "Learn from
 *    conversations" is on, a conversation a person has paused (10 minutes quiet) with 6 or more new messages of theirs is
 *    read once by the cheap model, and the pages that pass the checks are created: the project's in its own project,
 *    the owner's preferences and corrections in `_global` (read by every project's recall), and none the project's
 *    rules file already states (`rules-file.ts`). A new page that replaces one memory holds (named by the model, else a
 *    same-kind title close enough, `supersede.ts`) takes the old one out of default recall (`retirePage`). At most one
 *    run per hour and six per day, one conversation per run, so the bill is bounded: measured on the user's own
 *    sessions a run reads ~3k tokens and writes 0.2–0.5k, $0.015–0.018 on `claude-sonnet-5-5` (the `smol` role there).
 *
 * Only what a person typed is read: a subagent's or an agent-opened session carries an agent's words, and ai-memory's
 * server redacts secrets before they are stored.
 */
import { readFile } from "node:fs/promises";
import type { AiMemoryPageRef, AiMemoryProjectRef, AiMemorySession } from "../../shared/ai-memory";
import { writeFileAtomic } from "../atomic-file";
import type { AiMemoryClient } from "./client";
import {
	buildDigest,
	DISTILL_MIN_PROMPTS,
	type DigestPrompt,
	type DistillMessage,
	distillMessage,
	GLOBAL_PROJECT,
	KIND_LAYOUT,
	KNOWN_EXCERPT_CHARS,
	KNOWN_GLOBAL_PAGES,
	KNOWN_PROJECT_PAGES,
	type KnownPage,
	parseProposals,
	personPrompts,
	proposalMarkdown,
	proposalPath,
} from "./distill";
import type { ModelResult } from "./distill-model";
import { type RetitleClient, type RetitleReport, retitleSessionPages } from "./retitle";
import { readRulesText, rulesIndex, rulesOutline, statedByRules } from "./rules-file";
import { pageToReplace } from "./supersede";

export const UPKEEP_TICK_MS = 15 * 60_000;
/** A conversation is read once its person has been quiet this long. */
export const UPKEEP_IDLE_MS = 10 * 60_000;
export const UPKEEP_MIN_GAP_MS = 60 * 60_000;
export const UPKEEP_DAILY_MAX = 6;
const DAY_MS = 24 * 60 * 60_000;
const SCAN_SESSIONS = 100;
/** The first tick waits so the first tab and the wiring have the machine to themselves. */
const FIRST_TICK_MS = 2 * 60_000;

export type UpkeepClient = RetitleClient & Pick<AiMemoryClient, "sessions" | "createPage" | "retirePage">;

export type UpkeepLogMessage = "retitle" | "learn" | "failed";
export type UpkeepLogDetails = Record<string, string | number | boolean | null>;

export interface UpkeepDeps {
	client: UpkeepClient;
	/** Settings › Memory › Learn from conversations (default on: only a stored `false` is off), read per tick. */
	learn: () => boolean;
	/** The one model call (`distill-model.ts runSmol` on the user's omp); rejects when omp or the provider fails. */
	model: (message: DistillMessage) => Promise<ModelResult>;
	/** `<userData>/ai-memory/upkeep.json`: which conversations were read up to which message, and when the runs were. */
	stateFile: string;
	log: (message: UpkeepLogMessage, details: UpkeepLogDetails) => void;
	/** The rules files of the repository a folder is in (`rules-file.ts readRulesText`); a seam for the tests. */
	rules?: (cwd: string) => Promise<string>;
	now?: () => number;
	tickMs?: number;
	firstTickMs?: number;
}

interface UpkeepState {
	/** Per session: how many of its person prompts earlier runs have read. */
	sessions: Record<string, { done: number; at: string }>;
	/** Start times (ISO) of the runs in the last day. */
	runs: string[];
}

export type TickOutcome =
	| { ran: false; reason: "off" | "busy" | "gap" | "daily" | "nothing" }
	| {
			ran: true;
			session: string;
			project: string;
			prompts: number;
			created: string[];
			duplicates: number;
			/** Pages the project's rules file already states, not written. */
			inRules: number;
			/** `old → new` for each page a new one replaced (the old one left default recall). */
			superseded: string[];
			refused: string[];
			model: string;
			inputTokens: number;
			outputTokens: number;
			costUsd: number;
	  }
	| { ran: true; failed: string };

interface Candidate {
	project: AiMemoryProjectRef;
	session: AiMemorySession;
	all: DigestPrompt[];
	fresh: DigestPrompt[];
}

async function readState(file: string): Promise<UpkeepState> {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		const sessions = record.sessions && typeof record.sessions === "object" ? record.sessions : {};
		return {
			sessions: sessions as UpkeepState["sessions"],
			runs: Array.isArray(record.runs) ? record.runs.filter((run): run is string => typeof run === "string") : [],
		};
	} catch {
		return { sessions: {}, runs: [] };
	}
}

async function writeState(file: string, state: UpkeepState): Promise<void> {
	await writeFileAtomic(file, JSON.stringify(state));
}

function summarize(report: RetitleReport): UpkeepLogDetails {
	return {
		projects: report.projects,
		sessionPages: report.sessionPages,
		junk: report.junk,
		retitled: report.retitled.length,
		unresolved: report.unresolved.length,
		changed: report.changed.length,
		openHandoffs: report.openHandoffs,
		childHandoffsDiscarded: report.childHandoffs,
		failed: report.failed.length,
	};
}

export class MemoryUpkeep {
	readonly #deps: UpkeepDeps;
	#timer: NodeJS.Timeout | null = null;
	#first: NodeJS.Timeout | null = null;
	#repaired = false;
	#running = false;
	#disposed = false;
	/** Observation counts at the last look, so a session nobody wrote to since is not read again every tick. */
	readonly #seen = new Map<string, number>();
	/** Sessions with enough new messages that were not quiet yet: looked at again whatever their count. */
	readonly #waiting = new Set<string>();

	constructor(deps: UpkeepDeps) {
		this.#deps = deps;
	}

	get #now(): number {
		return (this.#deps.now ?? Date.now)();
	}

	/** The server answers: repair once per launch, then keep the schedule. */
	ready(): void {
		if (this.#disposed) return;
		if (!this.#repaired) {
			this.#repaired = true;
			void this.repair();
		}
		if (this.#timer) return;
		this.#first = setTimeout(() => void this.#safeTick(), this.#deps.firstTickMs ?? FIRST_TICK_MS);
		this.#first.unref();
		this.#timer = setInterval(() => void this.#safeTick(), this.#deps.tickMs ?? UPKEEP_TICK_MS);
		this.#timer.unref();
	}

	/** The server is gone (Memory turned off, stopped): nothing runs until `ready()` again. */
	pause(): void {
		clearTimeout(this.#first ?? undefined);
		clearInterval(this.#timer ?? undefined);
		this.#first = null;
		this.#timer = null;
	}

	dispose(): void {
		this.#disposed = true;
		this.pause();
	}

	async #safeTick(): Promise<void> {
		try {
			await this.tick();
		} catch (error) {
			this.#deps.log("failed", { step: "learn", detail: error instanceof Error ? error.message : String(error) });
		}
	}

	/** The repair: logs what it did, nothing when there was nothing to do. Never rejects. */
	async repair(): Promise<RetitleReport | null> {
		try {
			const report = await retitleSessionPages(this.#deps.client, { dryRun: false });
			if (report.retitled.length || report.childHandoffs || report.failed.length || report.unresolved.length) {
				this.#deps.log("retitle", summarize(report));
			}
			return report;
		} catch (error) {
			this.#deps.log("failed", { step: "retitle", detail: error instanceof Error ? error.message : String(error) });
			return null;
		}
	}

	/** One look at the conversations: at most one model call. Public for the tests. */
	async tick(): Promise<TickOutcome> {
		if (!this.#deps.learn()) return { ran: false, reason: "off" };
		if (this.#running) return { ran: false, reason: "busy" };
		this.#running = true;
		try {
			const state = await readState(this.#deps.stateFile);
			const now = this.#now;
			const runs = state.runs.filter(run => now - Date.parse(run) < DAY_MS);
			const last = runs.at(-1);
			if (last && now - Date.parse(last) < UPKEEP_MIN_GAP_MS) return { ran: false, reason: "gap" };
			if (runs.length >= UPKEEP_DAILY_MAX) return { ran: false, reason: "daily" };
			const candidate = await this.#pick(state, now);
			if (!candidate) return { ran: false, reason: "nothing" };
			// The attempt counts against the schedule whether the model answers or not: a broken omp is not retried every tick.
			state.runs = [...runs, new Date(now).toISOString()];
			await writeState(this.#deps.stateFile, state);
			return await this.#learn(candidate, state, now);
		} finally {
			this.#running = false;
		}
	}

	async #pick(state: UpkeepState, now: number): Promise<Candidate | null> {
		let best: Candidate | null = null;
		for (const project of await this.#deps.client.projects()) {
			// `_global` and the like are the profile's scope, written by the owner, never learned into.
			if (project.project.startsWith("_")) continue;
			const ref = { workspace: project.workspace, project: project.project };
			// One project the server cannot read (a name it calls ambiguous) never keeps the others from being learned.
			let sessions: AiMemorySession[];
			try {
				sessions = await this.#deps.client.sessions(ref, SCAN_SESSIONS);
			} catch (error) {
				this.#deps.log("failed", {
					step: "learn-project",
					project: `${ref.workspace}/${ref.project}`,
					detail: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			for (const session of sessions) {
				if (this.#seen.get(session.id) === session.observations && !this.#waiting.has(session.id)) continue;
				const all = await this.#personPrompts(ref, session.id);
				this.#seen.set(session.id, session.observations);
				const done = state.sessions[session.id]?.done ?? 0;
				const fresh = all.filter(prompt => prompt.n > done);
				if (fresh.length < DISTILL_MIN_PROMPTS) {
					this.#waiting.delete(session.id);
					continue;
				}
				// Enough to read: it stays on the list until a run has settled it, whether it is quiet yet or another one went first.
				this.#waiting.add(session.id);
				const lastAt = fresh.at(-1)?.at ?? null;
				if (lastAt === null || now - lastAt < UPKEEP_IDLE_MS) continue;
				if (!best || fresh.length > best.fresh.length) best = { project: ref, session, all, fresh };
			}
		}
		return best;
	}

	async #personPrompts(project: AiMemoryProjectRef, sessionId: string): Promise<DigestPrompt[]> {
		const observations = [];
		for (let offset = 0; ; ) {
			const page = await this.#deps.client.observations(project, sessionId, offset, ["user-prompt"]);
			observations.push(...page.observations);
			offset += page.observations.length;
			if (page.observations.length === 0 || offset >= page.total) break;
		}
		return personPrompts(observations);
	}

	/** The durable pages memory holds, newest first, with the start of each: the project's and the owner's preferences in `_global`. */
	async #knownPages(pages: readonly AiMemoryPageRef[]): Promise<KnownPage[]> {
		// `_global` exists once something wrote it; until then there is nothing to show.
		const global = await this.#deps.client.pages(GLOBAL_PROJECT).catch(() => []);
		const shown = [
			...pages.filter(page => !page.path.startsWith("sessions/")).slice(0, KNOWN_PROJECT_PAGES),
			...global
				.filter(page => page.path.startsWith(`${KIND_LAYOUT.preference.folder}/`))
				.slice(0, KNOWN_GLOBAL_PAGES),
		];
		return Promise.all(
			shown.map(async page => {
				const read = await this.#deps.client.page(page).catch(() => null);
				// The H1 is the title the model already reads.
				const excerpt = (read?.markdown ?? "")
					.replace(/^#[^\n]*\n/, "")
					.replaceAll(/\s+/g, " ")
					.trim();
				return {
					path: page.path,
					title: page.title,
					global: page.project === GLOBAL_PROJECT.project,
					...(excerpt ? { excerpt: excerpt.slice(0, KNOWN_EXCERPT_CHARS) } : {}),
					...(read?.id ? { id: read.id } : {}),
					...(read?.pinned ? { pinned: true } : {}),
				};
			}),
		);
	}

	async #learn(candidate: Candidate, state: UpkeepState, now: number): Promise<TickOutcome> {
		const { project, session, fresh } = candidate;
		const pages = await this.#deps.client.pages(project);
		const known = await this.#knownPages(pages);
		const sessionTitles = new Map(
			pages.filter(page => page.path.startsWith("sessions/")).map(page => [page.path, page.title] as const),
		);
		const since = fresh[0]?.at ?? 0;
		const tasks = (await this.#deps.client.sessions(project, SCAN_SESSIONS))
			.filter(other => other.id !== session.id && (other.startedAt ? Date.parse(other.startedAt) >= since : false))
			.flatMap(other => sessionTitles.get(`sessions/${other.id}.md`) ?? []);
		const digest = buildDigest(fresh, tasks);
		// The model sees the rules file's outline (it matches a Korean page to an English rule); `statedByRules` stays the
		// code backstop for what it still repeats.
		const rulesText = await (this.#deps.rules ?? readRulesText)(session.cwd ?? "").catch(() => "");
		let result: ModelResult;
		try {
			result = await this.#deps.model(distillMessage(digest, known, rulesOutline(rulesText)));
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.#deps.log("failed", { step: "learn-model", session: session.id, detail });
			return { ran: true, failed: detail };
		}
		const parsed = parseProposals(result.text, digest, known);
		const rules = rulesIndex(parsed.proposals.length ? rulesText : "");
		const created: string[] = [];
		const superseded: string[] = [];
		const retiredHere = new Set<string>();
		let duplicates = 0;
		let inRules = 0;
		for (const proposal of parsed.proposals) {
			if (statedByRules(rules, proposal)) {
				inRules += 1;
				parsed.refused.push(`${proposal.title}: the project's rules file already says it`);
				continue;
			}
			const path = proposalPath(proposal);
			const layout = KIND_LAYOUT[proposal.kind];
			const target = layout.global ? GLOBAL_PROJECT : project;
			const label = (page: string) => (layout.global ? `${GLOBAL_PROJECT.project}/${page}` : page);
			const replaced = pageToReplace(proposal, known);
			const written = await this.#deps.client.createPage({
				...target,
				path,
				body: proposalMarkdown(proposal, session.id, replaced?.path),
				tier: layout.tier,
				kind: layout.kind,
				...(layout.global ? {} : { sessionId: session.id }),
			});
			if (!written) {
				duplicates += 1;
				continue;
			}
			created.push(label(path));
			if (!replaced) continue;
			const key = label(replaced.path);
			if (!retiredHere.has(key)) {
				// Only once the new page exists, and only the version the model was shown: the old one leaves default recall.
				const retired = await this.#deps.client
					.retirePage({
						...target,
						path: replaced.path,
						successor: path,
						at: new Date(now),
						...(replaced.id ? { expectedPageId: replaced.id } : {}),
					})
					.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
				if (retired !== "retired") {
					parsed.refused.push(`${replaced.path}: not superseded (${retired})`);
					continue;
				}
				retiredHere.add(key);
			}
			superseded.push(`${key} → ${label(path)}`);
		}
		// An answer that parsed (even one with no pages) settles the window; an unusable answer is read again next time.
		const understood = parsed.proposals.length > 0 || parsed.refused.every(line => !line.startsWith("answer is not"));
		if (understood) {
			state.sessions[session.id] = { done: Math.max(...digest.shown, 0), at: new Date(now).toISOString() };
			await writeState(this.#deps.stateFile, state);
			this.#waiting.delete(session.id);
		}
		const outcome = {
			ran: true as const,
			session: session.id,
			project: `${project.workspace}/${project.project}`,
			prompts: digest.shown.length,
			created,
			duplicates,
			inRules,
			superseded,
			refused: parsed.refused,
			model: result.model,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			costUsd: result.costUsd,
		};
		this.#deps.log("learn", {
			session: session.id,
			project: outcome.project,
			prompts: outcome.prompts,
			created: created.length,
			duplicates,
			inRules,
			superseded: superseded.length,
			refused: parsed.refused.length,
			model: result.model,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			costUsd: Number(result.costUsd.toFixed(4)),
		});
		return outcome;
	}
}
