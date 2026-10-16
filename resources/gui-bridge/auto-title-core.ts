/**
 * Rules of the automatic session titles (modes/auto-title.ts runs them on the live session). No omp
 * imports: the GUI's vitest exercises them directly (src/main/bridge-auto-title-core.test.ts).
 *
 * Who owns a title (the origin) is stock's own record: `SessionManager.titleSource` ("auto" for a
 * generated title, "user" for one the person set, which is also what stock's RPC `set_session_name`
 * writes) and the journal's `title_change` entries. The one thing stock cannot say is "the person
 * asked for a fresh automatic title": stock refuses an "auto" write over a "user" title. Such a title
 * is written as source "user" with {@link TITLE_TRIGGER} on its `title_change` entry, and
 * {@link titleIsAuto} reads that stamp back, so no state lives outside the session file.
 */
import { TITLE_TRIGGER } from "./auto-title-contracts";

/** The slice of a journal entry the origin check reads. */
export interface TitleChangeLike {
	type: string;
	title?: string;
	source?: string;
	trigger?: string;
}

/**
 * Whether the session's current name is automatic (the bridge may replace it as the work moves on).
 * The last `title_change` entry that wrote the current name decides: source "auto", or the bridge's
 * stamp. A name no entry wrote (a session from before the journal, a header title) follows stock's
 * `titleSource`. A name the person typed, in the GUI or with stock's `/rename`, is never automatic.
 */
export function titleIsAuto(
	name: string | undefined,
	titleSource: string | undefined,
	entries: readonly TitleChangeLike[],
): boolean {
	if (!name) return false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "title_change") continue;
		if (entry.title === name) return entry.source === "auto" || entry.trigger === TITLE_TRIGGER;
		break;
	}
	return titleSource === "auto";
}

/** Lowercase letters and digits only (any script), words separated by one space. */
function normalizeTitle(title: string): string {
	return title
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let shared = 0;
	for (const item of a) if (b.has(item)) shared++;
	return shared / (a.size + b.size - shared);
}

function trigrams(text: string): Set<string> {
	const squeezed = text.replace(/ /g, "");
	const grams = new Set<string>();
	for (let i = 0; i + 3 <= squeezed.length; i++) grams.add(squeezed.slice(i, i + 3));
	if (grams.size === 0 && squeezed) grams.add(squeezed);
	return grams;
}

/** Word overlap above which two titles name the same thing; the same bar for character trigrams. */
const SAME_WORDS = 0.6;
const SAME_TRIGRAMS = 0.55;

/**
 * Whether `next` only rewords `current`: the same normalized text, or enough shared words or character
 * trigrams (the trigrams cover Korean and other scripts that do not split on spaces). A title that
 * only rewords is not applied, so the heading stays put until the topic really changed.
 */
export function isRewordedTitle(current: string, next: string): boolean {
	const a = normalizeTitle(current);
	const b = normalizeTitle(next);
	if (a === b) return true;
	if (jaccard(new Set(a.split(" ")), new Set(b.split(" "))) >= SAME_WORDS) return true;
	return jaccard(trigrams(a), trigrams(b)) >= SAME_TRIGRAMS;
}

/** Tools whose successful run changes a file. */
const FILE_TOOLS: Readonly<Record<string, true>> = { edit: true, write: true, ast_edit: true };

/** What a session event adds to the evolve gate: a file changed 1, the todo plan changed 2, the goal changed 3. */
export const WEIGHT = { file: 1, plan: 2, goal: 3 } as const;

export interface GateRules {
	/** Terminal turns that must pass since the title was set or last considered. */
	minTurns: number;
	/** Weight the work must have moved by (or {@link GateRules.forceTurns} turns must pass). */
	threshold: number;
	/** Turns after which a quiet session is considered anyway (a long conversation that changed course in words). */
	forceTurns: number;
	/** Shortest time between two considerations. */
	minIntervalMs: number;
}

export const DEFAULT_GATE_RULES: GateRules = { minTurns: 2, threshold: 3, forceTurns: 6, minIntervalMs: 60_000 };

export interface GateEvent {
	type: string;
	toolName?: string;
	isError?: boolean;
}

/**
 * Decides cheaply, with no model call, when a re-title is worth asking the title model for: after a
 * terminal `agent_end` once enough turns passed and the work has moved (files edited, todo plan or
 * goal changed), or many turns passed regardless. One consideration per window: it resets the counters
 * whether or not the title then changes, which is also the debounce.
 */
export class EvolveGate {
	#turns = 0;
	#weight = 0;
	#since: number;
	readonly #rules: GateRules;

	constructor(now: number, rules: GateRules = DEFAULT_GATE_RULES) {
		this.#since = now;
		this.#rules = rules;
	}

	/** The title was set (by anyone): start a new window. */
	reset(now: number): void {
		this.#turns = 0;
		this.#weight = 0;
		this.#since = now;
	}

	/** Feed every session event; only tool results and goal updates count. */
	note(event: GateEvent): void {
		if (event.type === "goal_updated") this.#weight += WEIGHT.goal;
		else if (event.type === "tool_execution_end" && event.isError !== true) {
			if (event.toolName === "todo") this.#weight += WEIGHT.plan;
			else if (event.toolName !== undefined && FILE_TOOLS[event.toolName] === true) this.#weight += WEIGHT.file;
		}
	}

	/** A terminal turn ended: true when the title model should be asked now (the window then restarts). */
	turnEnded(now: number): boolean {
		this.#turns++;
		const { minTurns, threshold, forceTurns, minIntervalMs } = this.#rules;
		if (now - this.#since < minIntervalMs) return false;
		if (this.#turns < minTurns) return false;
		if (this.#weight < threshold && this.#turns < forceTurns) return false;
		this.reset(now);
		return true;
	}
}
