/**
 * Memory's own upkeep beyond learning (upkeep.ts): units that tidy what is stored, run by themselves, quietly.
 *
 * - once after every OMPdesk update (the version in `care.json` differs), every unit runs again from the start;
 * - then on a schedule: a unit that finished runs again once its interval has passed, one that did not finish (the
 *   backfill walks its journals a budget at a time) goes on at the next tick;
 * - throttled: one unit per tick, ticks every 15 minutes, the first a few minutes after the server came up.
 *
 * Every page change a unit makes goes through the client this module hands it, which records it (title, the wiki
 * checkpoint that still holds the page as it was) so Settings › Memory › Maintenance can show one line and undo it
 * through the page's restore. A page the person brought back that way is the person's: no unit touches it again
 * (the wrapper answers `pinned` for it, which every unit already reads as "leave it").
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AiMemoryCareSummary, AiMemoryProjectRef } from "../../shared/ai-memory";
import type { AiMemoryClient } from "./client";

export const CARE_TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 5 * 60_000;
/** Changes older than this leave the Maintenance line (they stay in the pages' own history). */
const SHOWN_MS = 7 * 24 * 60 * 60_000;
const CHANGES_KEPT = 100;
const KEPT_MAX = 500;
/** A unit that threw tries again after this long, not every tick. */
const RETRY_MS = 60 * 60_000;

export type CareUnitName = "backfill" | "curate" | "fresh";
export type CareClient = Pick<AiMemoryClient, "retirePage" | "feedback">;

export interface CareUnit {
	name: CareUnitName;
	/** How long after it last finished it runs again; null: only after an update. */
	everyMs: number | null;
	/**
	 * One bounded step. `done` false: more is left for the next tick. `written`: conclusions added (backfill). `memo` is
	 * the unit's own record, kept in `care.json` across ticks and launches whatever the step ended in.
	 */
	run(client: CareClient, memo: Record<string, unknown>): Promise<{ done: boolean; written?: number }>;
}

interface CareChange extends AiMemoryProjectRef {
	path: string;
	title: string;
	action: "retired" | "flagged";
	/** The checkpoint read just before the change: the page as it stood, which undo restores. */
	rev: string;
	at: string;
	undone?: boolean;
}

interface CareState {
	version: string;
	units: Partial<Record<CareUnitName, { at: string; done: boolean; failed?: boolean }>>;
	/** `workspace/project/path` of pages the person restored: never changed by a unit again. */
	kept: string[];
	changes: CareChange[];
	/** Conclusions the backfill added, with when (for the line). */
	backfills: { at: string; written: number }[];
	memo: Partial<Record<CareUnitName, Record<string, unknown>>>;
}

export interface CareDeps {
	client: Pick<AiMemoryClient, "retirePage" | "feedback" | "page" | "headCheckpoint" | "restorePage">;
	units: CareUnit[];
	/** The running OMPdesk's version: a new one runs every unit again. */
	version: string;
	/** `<userData>/ai-memory/care.json`. */
	stateFile: string;
	log: (message: string, details: Record<string, string | number | boolean | null>) => void;
	now?: () => number;
	tickMs?: number;
	firstTickMs?: number;
}

const keyOf = (ref: AiMemoryProjectRef & { path: string }) => `${ref.workspace}/${ref.project}/${ref.path}`;

async function readState(file: string): Promise<CareState> {
	const empty: CareState = { version: "", units: {}, kept: [], changes: [], backfills: [], memo: {} };
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CareState>;
		return {
			version: typeof parsed.version === "string" ? parsed.version : "",
			units: parsed.units && typeof parsed.units === "object" ? parsed.units : {},
			kept: Array.isArray(parsed.kept) ? parsed.kept.filter(key => typeof key === "string") : [],
			changes: Array.isArray(parsed.changes) ? parsed.changes : [],
			backfills: Array.isArray(parsed.backfills) ? parsed.backfills : [],
			memo: parsed.memo && typeof parsed.memo === "object" ? parsed.memo : {},
		};
	} catch {
		return empty;
	}
}

async function writeState(file: string, state: CareState): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const next = `${file}.next`;
	await writeFile(next, JSON.stringify(state));
	await rename(next, file);
}

export class MemoryCare {
	readonly #deps: CareDeps;
	#timer: NodeJS.Timeout | null = null;
	#first: NodeJS.Timeout | null = null;
	#running: Promise<unknown> | null = null;
	#disposed = false;

	constructor(deps: CareDeps) {
		this.#deps = deps;
	}

	get #now(): number {
		return (this.#deps.now ?? Date.now)();
	}

	ready(): void {
		if (this.#disposed || this.#timer) return;
		this.#first = setTimeout(() => void this.tick(), this.#deps.firstTickMs ?? FIRST_TICK_MS);
		this.#first.unref();
		this.#timer = setInterval(() => void this.tick(), this.#deps.tickMs ?? CARE_TICK_MS);
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
	}

	/** One unit's step, the first one due; null when none is. Never rejects. Public for the tests. */
	async tick(): Promise<CareUnitName | null> {
		if (this.#running) return null;
		const run = this.#tick();
		this.#running = run;
		try {
			return await run;
		} finally {
			this.#running = null;
		}
	}

	async #tick(): Promise<CareUnitName | null> {
		const state = await readState(this.#deps.stateFile);
		if (state.version !== this.#deps.version) {
			state.version = this.#deps.version;
			state.units = {};
		}
		const now = this.#now;
		const unit = this.#deps.units.find(candidate => {
			const last = state.units[candidate.name];
			if (!last) return true;
			if (last.failed) return now - Date.parse(last.at) >= RETRY_MS;
			if (!last.done) return true;
			return candidate.everyMs !== null && now - Date.parse(last.at) >= candidate.everyMs;
		});
		if (!unit) {
			await writeState(this.#deps.stateFile, state);
			return null;
		}
		const changes: CareChange[] = [];
		const memo = state.memo[unit.name] ?? {};
		state.memo[unit.name] = memo;
		try {
			const result = await unit.run(this.#recording(state, changes), memo);
			state.units[unit.name] = { at: new Date(now).toISOString(), done: result.done };
			if (result.written) state.backfills.push({ at: new Date(now).toISOString(), written: result.written });
		} catch (error) {
			// Tried again after RETRY_MS, not every tick; what it finished before failing stays recorded.
			state.units[unit.name] = { at: new Date(now).toISOString(), done: false, failed: true };
			this.#deps.log("care-failed", {
				unit: unit.name,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
		state.changes = [...state.changes, ...changes].slice(-CHANGES_KEPT);
		state.backfills = state.backfills.filter(entry => now - Date.parse(entry.at) < SHOWN_MS);
		await writeState(this.#deps.stateFile, state);
		return unit.name;
	}

	/** The client a unit gets: changes are recorded with what undo needs; the person's restored pages are left alone. */
	#recording(state: CareState, changes: CareChange[]): CareClient {
		const { client } = this.#deps;
		const kept = new Set(state.kept);
		const before = async (ref: AiMemoryProjectRef & { path: string }) => {
			const [rev, page] = await Promise.all([client.headCheckpoint(), client.page(ref).catch(() => null)]);
			return { rev, title: page?.title || ref.path };
		};
		const record = (
			ref: AiMemoryProjectRef & { path: string },
			action: CareChange["action"],
			seen: { rev: string; title: string },
		) =>
			changes.push({
				workspace: ref.workspace,
				project: ref.project,
				path: ref.path,
				title: seen.title,
				action,
				rev: seen.rev,
				at: new Date(this.#now).toISOString(),
			});
		return {
			retirePage: async ref => {
				if (kept.has(keyOf(ref))) return "pinned";
				const seen = await before(ref);
				const result = await client.retirePage(ref);
				if (result === "retired") record(ref, "retired", seen);
				return result;
			},
			feedback: async (ref, signal) => {
				if (signal === "stale" || signal === "wrong") {
					// Refused, not skipped: a unit that logs its change on success then logs nothing for it.
					if (kept.has(keyOf(ref))) throw new Error("the person put this page back; it stays as it is");
					const seen = await before(ref);
					await client.feedback(ref, signal);
					record(ref, "flagged", seen);
					return;
				}
				await client.feedback(ref, signal);
			},
		};
	}

	/** The Maintenance line: what the units changed in the last week and not undone. Null when nothing. */
	async summary(): Promise<AiMemoryCareSummary | null> {
		const state = await readState(this.#deps.stateFile);
		const now = this.#now;
		const shown = state.changes.filter(change => !change.undone && now - Date.parse(change.at) < SHOWN_MS);
		const backfilled = state.backfills.reduce((sum, entry) => sum + entry.written, 0);
		if (!shown.length && !backfilled) return null;
		const times = [...shown.map(change => change.at), ...state.backfills.map(entry => entry.at)].sort();
		return {
			at: times.at(-1) ?? new Date(now).toISOString(),
			retired: shown.filter(change => change.action === "retired").length,
			flagged: shown.filter(change => change.action === "flagged").length,
			backfilled,
			pages: shown.map(change => ({
				workspace: change.workspace,
				project: change.project,
				path: change.path,
				title: change.title,
			})),
		};
	}

	/**
	 * Puts back every page shown on the line as it stood before the change (the page's restore from that checkpoint, a
	 * new version without the expiry or the flag) and keeps each from the units from now on. Returns how many came back.
	 */
	async undo(): Promise<number> {
		await this.#running;
		const state = await readState(this.#deps.stateFile);
		const now = this.#now;
		let restored = 0;
		for (const change of state.changes) {
			if (change.undone || now - Date.parse(change.at) >= SHOWN_MS || !change.rev) continue;
			try {
				await this.#deps.client.restorePage(change, change.rev);
			} catch (error) {
				this.#deps.log("care-failed", {
					unit: "undo",
					path: change.path,
					detail: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			change.undone = true;
			restored += 1;
			state.kept = [...new Set([...state.kept, keyOf(change)])].slice(-KEPT_MAX);
			this.#deps.log("care-undo", {
				project: `${change.workspace}/${change.project}`,
				path: change.path,
				action: change.action,
			});
		}
		await writeState(this.#deps.stateFile, state);
		return restored;
	}
}
