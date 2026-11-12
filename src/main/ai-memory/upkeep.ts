/**
 * What OMPdesk does for memory's quality once the server is up, with ai-memory's own write paths and nothing else. The
 * work is the core's (`native/ompdesk/crates/core/src/upkeep/engine.rs`):
 *
 * 1. **Repair, once per launch**: ambiguous names renamed, session pages filed under protocol text get their task's
 *    name, and the handoffs a child session left are discarded. Idempotent, so a launch with nothing to repair does two reads.
 * 2. **Learn**: ai-memory writes session pages by itself but no decisions, rules or gotchas (its own consolidation needs
 *    an LLM provider on the server, which OMPdesk keeps out). A conversation a person has paused (10 minutes quiet) with
 *    6 or more new messages of theirs is read once by the cheap model, and the pages that pass the checks are created:
 *    the project's in its own project, the owner's preferences and corrections in `_global` (read by every project's
 *    recall), and none the project's rules file already states. A new page that replaces one memory holds (named by the
 *    model) takes the old one out of default recall. At most one run per hour and six per day, one conversation per run,
 *    so the bill is bounded.
 *
 * Only what a person typed is read: a subagent's or an agent-opened session carries an agent's words, and ai-memory's
 * server redacts secrets before they are stored.
 *
 * This file keeps the timers (each tick and each repair is one request to the core) and answers what the core asks of
 * main: in production the omp to run (`omp`); a test's fake client, model, rules and clock are asked for through
 * `core-asks.ts`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { core } from "../core/process";
import type { AiMemoryClient } from "./client";
import { type AskHandler, answerAsks, type CoreSide, collatorLocale, coreSide, onLog, serviceName } from "./core-asks";
import type { DistillMessage, ModelResult, OmpLaunch } from "./distill-model";
import type { RetitleClient, RetitleReport } from "./retitle";

export const UPKEEP_TICK_MS = 15 * 60_000;
// The core's own schedule (engine.rs): the tests drive its clock with these.
/** A conversation is read once its person has been quiet this long. */
export const UPKEEP_IDLE_MS = 10 * 60_000;
export const UPKEEP_MIN_GAP_MS = 60 * 60_000;
export const UPKEEP_DAILY_MAX = 6;
/** The first tick waits so the first tab and the wiring have the machine to themselves. */
const FIRST_TICK_MS = 2 * 60_000;
/** A tick is the model call (the core's 180 s limit) and the reads and writes around it; a repair reads every project. */
const TICK_TIMEOUT_MS = 300_000;
const REPAIR_TIMEOUT_MS = 600_000;

export type UpkeepClient = RetitleClient &
	Pick<AiMemoryClient, "sessions" | "createPage" | "retirePage" | "nameStatus" | "renameUnclaimedProject">;

export type UpkeepLogMessage = "retitle" | "learn" | "failed" | "renamed";
export type UpkeepLogDetails = Record<string, string | number | boolean | null>;

export interface UpkeepDeps {
	client: UpkeepClient;
	/** A test's stand-in for the one model call; production runs omp (`omp`). Rejects when omp or the provider fails. */
	model?: (message: DistillMessage) => Promise<ModelResult>;
	/** How omp starts (`core-asks.ts ompLaunch()`); the core runs the model call itself. */
	omp?: () => Promise<OmpLaunch>;
	/** The empty folder the model call runs in. */
	modelCwd?: string;
	/** `<userData>/ai-memory/upkeep.json`: which conversations were read up to which message, and when the runs were. */
	stateFile: string;
	log: (message: UpkeepLogMessage, details: UpkeepLogDetails) => void;
	/** The rules files of the repository a folder is in; a seam for the tests (the core reads them itself otherwise). */
	rules?: (cwd: string) => Promise<string>;
	/** The clock the core reads while a request runs (a test drives it); the system's without it. */
	now?: () => number;
	tickMs?: number;
	firstTickMs?: number;
}

export type TickOutcome =
	| { ran: false; reason: "busy" | "gap" | "daily" | "nothing" }
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

export class MemoryUpkeep {
	readonly #deps: UpkeepDeps;
	readonly #service = serviceName();
	readonly #side: CoreSide;
	#timer: NodeJS.Timeout | null = null;
	#first: NodeJS.Timeout | null = null;
	#repaired = false;
	#disposed = false;
	/** Ends the answers of the core's asks and the log lines of this service; null before the first request. */
	#unlisten: (() => void) | null = null;

	constructor(deps: UpkeepDeps) {
		this.#deps = deps;
		const answers: Record<string, AskHandler> = {};
		const { model, rules, omp } = deps;
		if (model) answers.model = params => model((params as { message: DistillMessage }).message);
		if (rules) answers.rules = params => rules((params as { cwd: string }).cwd);
		if (omp) answers.omp = () => omp();
		this.#side = coreSide(deps.client, answers);
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
		if (!this.#unlisten) return;
		this.#unlisten();
		this.#unlisten = null;
		// What the core remembered of this service goes with it; a core that is gone has nothing to forget.
		void core()
			.call("upkeep.close", { service: this.#service })
			.catch(() => {});
	}

	async #safeTick(): Promise<void> {
		try {
			await this.tick();
		} catch (error) {
			this.#deps.log("failed", { step: "learn", detail: error instanceof Error ? error.message : String(error) });
		}
	}

	/** One request's members: the service, what main answers and the server, where the model runs, the files and the clock. */
	#request(): Record<string, unknown> {
		if (!this.#unlisten) {
			const stopAsks = answerAsks(this.#service, this.#side.handlers);
			const stopLog = onLog(this.#service, (message, details) =>
				this.#deps.log(message as UpkeepLogMessage, details as UpkeepLogDetails),
			);
			this.#unlisten = () => {
				stopAsks();
				stopLog();
			};
		}
		return {
			service: this.#service,
			...this.#side.wire(),
			locale: collatorLocale(),
			stateFile: this.#deps.stateFile,
			modelCwd: this.#deps.modelCwd ?? join(tmpdir(), "ompdesk-memory-upkeep"),
			...(this.#deps.now ? { now: this.#deps.now() } : {}),
		};
	}

	/** The repair: logs what it did, nothing when there was nothing to do. Never rejects. */
	async repair(): Promise<RetitleReport | null> {
		try {
			const answer = await core().call<RetitleReport | null>("upkeep.repair", this.#request(), {
				timeoutMs: REPAIR_TIMEOUT_MS,
			});
			return answer.result;
		} catch (error) {
			this.#deps.log("failed", { step: "retitle", detail: error instanceof Error ? error.message : String(error) });
			return null;
		}
	}

	/** One look at the conversations: at most one model call. Public for the tests. */
	async tick(): Promise<TickOutcome> {
		const answer = await core().call<TickOutcome>("upkeep.tick", this.#request(), { timeoutMs: TICK_TIMEOUT_MS });
		return answer.result;
	}
}
