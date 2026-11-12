/**
 * Memory's own upkeep beyond learning (upkeep.ts): units that tidy what is stored, run by themselves, quietly. The work
 * is the core's (`native/ompdesk/crates/core/src/care/`: `engine.rs` the schedule, the state file, the recording client
 * and the undo; `units.rs` the three units; `backfill.rs`, `curate.rs`, `judge.rs`, `freshness.rs` what they do):
 *
 * - once after every OMPdesk update (the version in `care.json` differs), every unit runs again from the start;
 * - then on a schedule: a unit that finished runs again once its interval has passed, one that did not finish (the
 *   backfill walks its journals a budget at a time) goes on at the next tick;
 * - throttled: one unit per tick, ticks every 15 minutes, the first a few minutes after the server came up.
 *
 * Every page change a unit makes goes through the recording client of the core, which records it (title, the wiki
 * checkpoint that still holds the page as it was) so Settings › Memory › Maintenance can show one line and undo it
 * through the page's restore. A page the person brought back that way is the person's: no unit touches it again.
 *
 * This file keeps the timers (each tick is one request to the core) and answers what the core asks of main: in
 * production the omp to run (`omp`); a test's fake client and its own units are asked for through `core-asks.ts`. The production configuration (the sessions folder, this computer's device id, how to judge,
 * git's rules) travels with every tick.
 */
import type { AiMemoryCareSummary } from "../../shared/ai-memory";
import { core } from "../core/process";
import { gitRunner } from "../local/git/exec";
import type { AiMemoryClient } from "./client";
import { type AskHandler, answerAsks, type CoreSide, collatorLocale, coreSide, onLog, serviceName } from "./core-asks";
import type { OmpLaunch } from "./distill-model";

export const CARE_TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 5 * 60_000;
/** A tick is one unit's step: a backfill budget of journals, a judge run (180 s) or the checks of every project. */
const TICK_TIMEOUT_MS = 30 * 60_000;
const SUMMARY_TIMEOUT_MS = 30_000;
/** An undo restores every page of the line, one request to the server each. */
const UNDO_TIMEOUT_MS = 10 * 60_000;
/** One call a test's unit makes on its client. */
const UNIT_CALL_TIMEOUT_MS = 60_000;

export type CareUnitName = "backfill" | "curate" | "fresh";
export type CareClient = Pick<AiMemoryClient, "retirePage" | "feedback">;

/** A test's own unit (the real three are the core's). */
export interface CareUnit {
	name: CareUnitName;
	/** How long after it last finished it runs again; null: only after an update. */
	everyMs: number | null;
	/**
	 * One bounded step. `done` false: more is left for the next tick. `written`: conclusions added (backfill). `memo` is
	 * the unit's own record, kept in `care.json` across ticks and launches; what the unit changes in it comes back to
	 * the core with the step's answer (a unit that throws leaves it as it was).
	 */
	run(client: CareClient, memo: Record<string, unknown>): Promise<{ done: boolean; written?: number }>;
}

/** How production judges a pair of pages (`care/judge.rs`: Jev through stock's judge chain, then the cheap model). */
export interface CareJudge {
	/** Settings › Agent behavior's judge switch (`judgeAssistEnabled(prefs.judgeAssist)`), read per tick. */
	enabled: () => boolean;
	/** `resources/gui-bridge/memory-judge-host.ts`. */
	hostFile: string;
	/** An empty folder for omp to run in: a repository's would load its AGENTS.md. */
	cwd: string;
}

export interface CareDeps {
	/** The real client (the core reads the server itself) or a test's fake (every call is asked of it). */
	client: Pick<AiMemoryClient, "retirePage" | "feedback" | "page" | "headCheckpoint" | "restorePage">;
	/** A test's own units; production runs the three of the core (backfill, curate, fresh). */
	units?: CareUnit[];
	/** The running OMPdesk's version: a new one runs every unit again. */
	version: string;
	/** `<userData>/ai-memory/care.json`. */
	stateFile: string;
	log: (message: string, details: Record<string, string | number | boolean | null>) => void;
	/** The stock sessions folder the backfill reads journals from (`sessionIndex.sessionsDir`). */
	sessionsDir?: string;
	/** This computer's device id: the origin backfilled conclusions are written under (sync.ts `selfId`). */
	origin?: () => string;
	judge?: CareJudge;
	/** How omp starts (`core-asks.ts ompLaunch()`); the core runs the judge's omp itself. */
	omp?: () => Promise<OmpLaunch>;
	/** The clock the core reads while a request runs (a test drives it); the system's without it. */
	now?: () => number;
	tickMs?: number;
	firstTickMs?: number;
}

/** `value[key]` when `value` is an object holding it. */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

export class MemoryCare {
	readonly #deps: CareDeps;
	readonly #service = serviceName();
	readonly #side: CoreSide;
	#timer: NodeJS.Timeout | null = null;
	#first: NodeJS.Timeout | null = null;
	#disposed = false;
	/** Ends the answers of the core's asks and the log lines of this service; null before the first request. */
	#unlisten: (() => void) | null = null;

	constructor(deps: CareDeps) {
		this.#deps = deps;
		const answers: Record<string, AskHandler> = {};
		if (deps.units) answers.unit = params => this.#runUnit(params);
		if (deps.omp) answers.omp = () => deps.omp?.();
		this.#side = coreSide(deps.client, answers);
	}

	ready(): void {
		if (this.#disposed || this.#timer) return;
		this.#first = setTimeout(() => void this.#safeTick(), this.#deps.firstTickMs ?? FIRST_TICK_MS);
		this.#first.unref();
		this.#timer = setInterval(() => void this.#safeTick(), this.#deps.tickMs ?? CARE_TICK_MS);
		this.#timer.unref();
	}

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
			.call("care.close", { service: this.#service })
			.catch(() => {});
	}

	async #safeTick(): Promise<void> {
		try {
			await this.tick();
		} catch (error) {
			this.#deps.log("care-failed", {
				unit: "tick",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** One request's members: the service, what main answers, the server, and the clock. */
	#request(): Record<string, unknown> {
		if (!this.#unlisten) {
			const stopAsks = answerAsks(this.#service, this.#side.handlers);
			const stopLog = onLog(this.#service, (message, details) => this.#deps.log(message, details));
			this.#unlisten = () => {
				stopAsks();
				stopLog();
			};
		}
		return {
			service: this.#service,
			...this.#side.wire(),
			locale: collatorLocale(),
			...(this.#deps.now ? { now: this.#deps.now() } : {}),
		};
	}

	/** A test's unit, run for the core: its client calls go back to the core's recording client of this run. */
	async #runUnit(params: unknown): Promise<{ done: boolean; written?: number; memo: Record<string, unknown> }> {
		const run = field(params, "run");
		const name = field(params, "name");
		const memoIn = field(params, "memo");
		const unit = this.#deps.units?.find(candidate => candidate.name === name);
		if (!unit) throw new Error(`No unit named ${String(name)}`);
		const memo: Record<string, unknown> = memoIn !== null && typeof memoIn === "object" ? { ...memoIn } : {};
		const call = async (op: string, args: unknown[]): Promise<unknown> =>
			(
				await core().call(
					"care.unitCall",
					{ service: this.#service, run, op, args },
					{ timeoutMs: UNIT_CALL_TIMEOUT_MS },
				)
			).result;
		const client: CareClient = {
			retirePage: async ref => (await call("retirePage", [ref])) as "retired" | "pinned" | "changed",
			feedback: async (ref, signal) => {
				await call("feedback", [ref, signal]);
			},
		};
		const result = await unit.run(client, memo);
		return { ...result, memo };
	}

	/** One unit's step, the first one due; null when none is. Public for the tests. */
	async tick(): Promise<CareUnitName | null> {
		const deps = this.#deps;
		const production = deps.units
			? { units: deps.units.map(unit => ({ name: unit.name, everyMs: unit.everyMs })) }
			: {
					sessionsDir: deps.sessionsDir ?? "",
					origin: deps.origin?.() ?? "",
					...(deps.judge
						? { judge: { enabled: deps.judge.enabled(), hostFile: deps.judge.hostFile, cwd: deps.judge.cwd } }
						: {}),
					// A git that is not installed is git not knowing: the freshness check finds no checkout.
					git: await gitRunner().catch(() => null),
				};
		const answer = await core().call<CareUnitName | null>(
			"care.tick",
			{ ...this.#request(), stateFile: deps.stateFile, version: deps.version, ...production },
			{ timeoutMs: TICK_TIMEOUT_MS },
		);
		return answer.result;
	}

	/** The Maintenance line: what the units changed in the last week and not undone. Null when nothing. */
	async summary(): Promise<AiMemoryCareSummary | null> {
		const answer = await core().call<AiMemoryCareSummary | null>(
			"care.summary",
			{ ...this.#request(), stateFile: this.#deps.stateFile },
			{ timeoutMs: SUMMARY_TIMEOUT_MS },
		);
		return answer.result;
	}

	/**
	 * Puts back every page shown on the line as it stood before the change (the page's restore from that checkpoint, a
	 * new version without the expiry or the flag) and keeps each from the units from now on. Returns how many came back.
	 * It waits for a tick that is running.
	 */
	async undo(): Promise<number> {
		const answer = await core().call<number>(
			"care.undo",
			{ ...this.#request(), stateFile: this.#deps.stateFile },
			{ timeoutMs: UNDO_TIMEOUT_MS },
		);
		return answer.result;
	}
}
