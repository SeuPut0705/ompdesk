/**
 * Dependency-free contracts of the built-in prompt suggestions, shared by main,
 * the renderer and the packaged bridge (modes/next-prompt.ts, rules in
 * next-prompt-core.ts). Stock omp's own composer prediction
 * (`composer.predictions`, ComposerPredictionController) runs only in its TUI;
 * over RPC nothing predicts, so OMPdesk runs the same idea itself.
 */

/** prefs keys (electron-store `prefs`); both default on. */
export const NEXT_PROMPT_PREF = "nextPromptSuggestions";
export const NEXT_PROMPT_INLINE_PREF = "nextPromptInline";

/** Spawn env: JSON of {@link NextPromptSettings}. */
export const NEXT_PROMPT_ENV = "OMP_GUI_NEXT_PROMPT";

export interface NextPromptSettings {
	/** After each turn, suggest the next message (best one as placeholder, the rest as chips). */
	suggestions: boolean;
	/** Sub-switch: ghost text after the caret while typing. Only effective while `suggestions` is on. */
	inline: boolean;
}

export const DEFAULT_NEXT_PROMPT: NextPromptSettings = { suggestions: true, inline: true };

/** The inline sub-switch counts only under the main one. */
export function inlineEffective(settings: NextPromptSettings): boolean {
	return settings.suggestions && settings.inline;
}

/** Two stored prefs (anything not a boolean reads as the default, on) → settings. */
export function nextPromptFromPrefs(suggestions: unknown, inline: unknown): NextPromptSettings {
	return {
		suggestions: typeof suggestions === "boolean" ? suggestions : DEFAULT_NEXT_PROMPT.suggestions,
		inline: typeof inline === "boolean" ? inline : DEFAULT_NEXT_PROMPT.inline,
	};
}

/** Untrusted JSON (env value, bridge params) → settings; a missing or malformed value reads as the default (on). */
export function normalizeNextPrompt(raw: unknown): NextPromptSettings {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_NEXT_PROMPT };
	const { suggestions, inline } = raw as Record<string, unknown>;
	return nextPromptFromPrefs(suggestions, inline);
}

/** `OMP_GUI_NEXT_PROMPT` → settings. */
export function parseNextPromptEnv(raw: string | undefined): NextPromptSettings {
	if (!raw) return { ...DEFAULT_NEXT_PROMPT };
	try {
		return normalizeNextPrompt(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_NEXT_PROMPT };
	}
}

/** Why suggestions are unavailable (the composer footer hint names it). */
export type NextPromptUnavailable =
	/** Stock's `smol` role resolves to no available model. */
	| "no_model"
	/** The resolved model has no credentials. */
	| "no_credentials"
	/** The provider or transport refused the request (output cap, model access). */
	| "refused"
	/** The request could not reach the provider. */
	| "offline"
	/** This omp lacks an internal the feature needs (capabilities.ts `nextPrompt`). */
	| "unsupported"
	| "error";

export const NEXT_PROMPT_UNAVAILABLE: readonly NextPromptUnavailable[] = [
	"no_model",
	"no_credentials",
	"refused",
	"offline",
	"unsupported",
	"error",
];

/**
 * What caused a (re)generation. Only `refresh` (the renderer asking past an unchanged moment) is forced; `draft` (the
 * person emptied the composer) asks only when the moment moved since the last suggestion, so typing and clearing a
 * draft keeps the suggestion the person saw instead of replacing it.
 */
export type NextPromptTrigger = "turn" | "compaction" | "bash" | "switch" | "refresh" | "draft";

/** The renderer-reported reasons of `refresh_next_prompt`; the bridge adds `turn`, `compaction` and `switch` itself. */
export const NEXT_PROMPT_REFRESH_REASONS = ["bash", "switch", "refresh"] as const;
export type NextPromptRefreshReason = (typeof NEXT_PROMPT_REFRESH_REASONS)[number];

/**
 * A session the main agent opened with OMPdesk's control tools (`ompdesk_session_open`) that still runs or waits for
 * an answer. Main pushes the list (`set_next_prompt_children` → bridge `next_prompt_children`) whenever the work
 * board's review list changes: those sessions run in their own tabs, so stock's async jobs never list them.
 */
export interface NextPromptChild {
	title: string;
	/** It asked its opener a question (or is blocked) and waits for the answer. */
	waiting?: boolean;
}
/** At most this many children are pushed; the prompt shows fewer. */
export const MAX_NEXT_PROMPT_CHILDREN = 20;

/** At most this many candidates: the best (placeholder) plus the chips. */
export const MAX_CANDIDATES = 3;
/**
 * One candidate never exceeds this many characters: a message the user would type is short, and the chips and the
 * one-line placeholder show it whole. Korean, Chinese and Japanese pack a word into one or two characters, so their
 * limit is lower than the one for Latin and other scripts.
 */
export const MAX_CANDIDATE_CHARS_CJK = 40;
export const MAX_CANDIDATE_CHARS = 60;

/** Where the cheap request ran. `provider/id`, and the stock role that resolved it. */
export interface NextPromptModelUsed {
	model: string;
	role: string;
}

/**
 * Pushed by the bridge as the `next_prompt_update` frame (and returned by `get_next_prompt` as `last`).
 * `ready` with no candidates = nothing natural fits; `unavailable` names why; `cleared` = drop what the
 * session showed (a new run began, the user typed, the feature was switched off).
 */
export interface NextPromptUpdate {
	type: "next_prompt_update";
	status: "ready" | "unavailable" | "cleared";
	/** The session this belongs to: the same key the renderer derives (`sessionFile || sessionId`). */
	sessionFile?: string;
	sessionId?: string;
	trigger?: NextPromptTrigger;
	/** Ranked best first, deduplicated, one line each; at most {@link MAX_CANDIDATES}. */
	candidates?: string[];
	reason?: NextPromptUnavailable;
	/** The provider's or stock's own message, for the debug log and a tooltip. */
	detail?: string;
	used?: NextPromptModelUsed;
	ms?: number;
}

/**
 * Journal entry type (`sessionManager.appendCustomEntry`) holding a session's last suggestion: `{candidates, used?,
 * at, key}`. An omp started on the session (a relaunch, an update's restart) answers it as `last` until a later
 * message makes it stale, so a suggestion outlives the process that made it.
 */
export const NEXT_PROMPT_ENTRY = "ompdesk.next-prompt";

/**
 * The session's last suggestion (`NextPromptState.last`): what the bridge pushed last for it, kept so a page that
 * missed the frame (its tab was in the background, a reload, a phone that was hidden, a paired host's link that
 * dropped, a relaunch) gets it back on its next hydration. Empty `candidates`: a run made the last one stale, or
 * nothing natural fitted.
 */
export interface NextPromptLast {
	candidates: string[];
	used?: NextPromptModelUsed;
	/** When it was made, epoch ms on the clock of the computer the session runs on. */
	at: number;
	sessionFile?: string;
	sessionId?: string;
}

/** What a tab's bridge reports about the feature (`get_next_prompt`, and the `next_prompt_config` frame). */
export interface NextPromptState {
	suggestions: boolean;
	inline: boolean;
	/** The user's own `next-prompt` extension is loaded too; its widget is ignored while `suggestions` is on. */
	legacyExtension: boolean;
	/** The model the cheap requests run on, or why there is none. */
	model?: NextPromptModelUsed;
	unavailable?: NextPromptUnavailable;
	detail?: string;
	/** Requests this omp has made since it started, by kind (the cost of the feature). */
	requests: { suggest: number; inline: number };
	/** The main session's last suggestion (`get_next_prompt` only; absent: none known, or an older bridge). */
	last?: NextPromptLast;
}

/** The `next_prompt_config` frame. */
export interface NextPromptConfigFrame extends NextPromptState {
	type: "next_prompt_config";
}

/** `complete_inline` result. `text` is the continuation to show after the caret, null when nothing fits. */
export interface InlineCompletion {
	requestId: string;
	text: string | null;
	reason?: NextPromptUnavailable;
	used?: NextPromptModelUsed;
	ms?: number;
}

/** Longest draft (characters) the inline request ever sends. */
export const INLINE_MAX_DRAFT_CHARS = 400;
/** Fewest characters a draft needs before an inline request is made. */
export const INLINE_MIN_DRAFT_CHARS = 8;
/** Quiet time after the last keystroke before an inline request is made. */
export const INLINE_DEBOUNCE_MS = 600;
