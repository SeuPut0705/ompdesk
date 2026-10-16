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

/** The most words a title keeps ({@link titleLanguageLine} asks for 2-5). */
export const TITLE_MAX_WORDS = 5;
/** The most characters a title in Korean, Chinese or Japanese keeps, where word counts say little. */
export const TITLE_MAX_CJK_CHARS = 20;

/**
 * The line that puts a title in the person's language and keeps it short, appended to stock's own
 * `title-system.md` (whose rules and examples are English only, so a cheap title model answers in English, and
 * whose 3-6 words read long). The language the person writes in comes first, so a Korean request gets a Korean
 * title whatever the reply language is; `language` (the reply language) decides only when the request shows none
 * (code, names, a mix). {@link conciseTitle} enforces the length on what comes back.
 */
export function titleLanguageLine(language: string): string {
	return `Language and length (this overrides the 3-6 words above): write the title in the language the user writes in, even though the examples above are in English; when that is unclear (only code, names or a mix), write it in ${language}. Keep it short: 2-${TITLE_MAX_WORDS} words, and at most ${TITLE_MAX_CJK_CHARS} characters in Korean, Chinese or Japanese; no filler words. Keep code identifiers, file names and proper nouns as the user wrote them.`;
}

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * `title` (without its card) cut to whole words: at most {@link TITLE_MAX_WORDS}, and for a title in Korean,
 * Chinese or Japanese at most {@link TITLE_MAX_CJK_CHARS} characters. Never an ellipsis and never part of a word,
 * so the first word stays even when it alone is longer; a cut drops trailing punctuation-only words and the
 * separator left on the last word (`,` `:` `;` `-`).
 */
export function conciseTitle(title: string): string {
	const words = title.trim().split(/\s+/);
	const kept = words.slice(0, TITLE_MAX_WORDS);
	if (CJK.test(title)) while (kept.length > 1 && kept.join(" ").length > TITLE_MAX_CJK_CHARS) kept.pop();
	if (kept.length === words.length) return words.join(" ");
	while (kept.length > 1 && !HAS_WORD.test(kept[kept.length - 1] ?? "")) kept.pop();
	return kept.join(" ").replace(/[\s,:;\-–—/&]+$/u, "") || kept.join(" ");
}

/** What a session's title prompt override should be: `keep` leaves it as it is. */
export type TitlePromptPlan = { keep: true } | { keep: false; prompt: string | undefined };

/**
 * The title prompt override (`AgentSession.titleSystemPrompt`) a session should carry for `language` (the reply
 * language: undefined when off, unset or English). `current` is what the session holds, `own` what OMPdesk last set
 * there. Any other value is the person's own TITLE_SYSTEM.md: stock treats it as the whole title prompt, so it is
 * kept as written. Otherwise: stock's prompt plus {@link titleLanguageLine}, or no override (stock's bundled prompt,
 * byte for byte) without a language.
 */
export function planTitlePrompt(
	current: string | undefined,
	own: string | undefined,
	stockPrompt: string,
	language: string | undefined,
): TitlePromptPlan {
	if (current !== undefined && current !== own) return { keep: true };
	return { keep: false, prompt: language ? `${stockPrompt.trimEnd()}\n\n${titleLanguageLine(language)}` : undefined };
}
