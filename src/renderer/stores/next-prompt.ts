import { create } from "zustand";
import type { NextPromptModelUsed, NextPromptUpdate } from "../../../resources/gui-bridge/next-prompt-contracts";
import { parseNextPrompt } from "../lib/next-prompt";

/**
 * GUI-owned memory of the suggestion shown for each session.
 *
 * Two sources feed it: the built-in bridge's `next_prompt_update` frames
 * (`recordUpdate`) and the user's legacy `next-prompt` omp extension widget
 * (`recordWidget`). The renderer wipes extension widgets on every session
 * switch and the bridge clears on input, so neither alone can outlive a switch
 * or a deleted draft. This store keeps the last suggestion for each session
 * (session file path, else session id) until it is genuinely stale: the user
 * submits in that session, a run starts there, or a newer suggestion replaces
 * it. The legacy extension's own clears are ignored.
 */

/** Sessions remembered at once; the least recently recorded drop first. */
const MAX_SESSIONS = 50;

/** One session's remembered suggestion: ranked candidates, best first. */
export interface StoredSuggestion {
	candidates: string[];
	/** Model the built-in request ran on; absent for the legacy widget. */
	used?: NextPromptModelUsed;
	/** Epoch ms it was recorded. */
	at: number;
}

export interface NextPromptStore {
	/** Suggestion per session key, oldest record first. */
	suggestions: Record<string, StoredSuggestion>;
	/** Apply a built-in `next_prompt_update`: `ready` with candidates replaces the
	 * session's entry, `ready` with none and `cleared` drop it, `unavailable`
	 * leaves the memory alone. Each frame object counts once. */
	recordUpdate: (sessionKey: string, update: NextPromptUpdate) => void;
	/** Record a `next-prompt` widget publication for a session. Each published
	 * line array counts once, so a remount never resurrects a suggestion the
	 * user already consumed; empty widgets (the extension's clears) are ignored. */
	recordWidget: (sessionKey: string, lines: readonly string[] | undefined) => void;
	/** Forget the suggestion of every given session key. */
	clear: (...sessionKeys: (string | null | undefined)[]) => void;
	reset: () => void;
}

/** Widget line arrays and update frames already recorded (each publication is a fresh object). */
let recorded = new WeakSet<object>();

/** Replace one session's entry, evicting the oldest sessions beyond the bound. */
function remember(
	current: Record<string, StoredSuggestion>,
	sessionKey: string,
	entry: StoredSuggestion,
): Record<string, StoredSuggestion> {
	const { [sessionKey]: _previous, ...rest } = current;
	const keys = Object.keys(rest);
	for (const key of keys.slice(0, Math.max(0, keys.length - (MAX_SESSIONS - 1)))) delete rest[key];
	return { ...rest, [sessionKey]: entry };
}

export const useNextPromptStore = create<NextPromptStore>()((set, get) => ({
	suggestions: {},
	recordUpdate: (sessionKey, update) => {
		if (recorded.has(update)) return;
		recorded.add(update);
		if (update.status === "unavailable") return;
		const candidates = update.status === "ready" ? (update.candidates ?? []).filter(text => text.trim() !== "") : [];
		if (candidates.length === 0) {
			get().clear(sessionKey);
			return;
		}
		set({ suggestions: remember(get().suggestions, sessionKey, { candidates, used: update.used, at: Date.now() }) });
	},
	recordWidget: (sessionKey, lines) => {
		if (!lines || recorded.has(lines)) return;
		recorded.add(lines);
		const text = parseNextPrompt(lines);
		if (text === undefined) return;
		set({ suggestions: remember(get().suggestions, sessionKey, { candidates: [text], at: Date.now() }) });
	},
	clear: (...sessionKeys) => {
		const keys = sessionKeys.filter((key): key is string => !!key && key in get().suggestions);
		if (keys.length === 0) return;
		const suggestions = { ...get().suggestions };
		for (const key of keys) delete suggestions[key];
		set({ suggestions });
	},
	reset: () => {
		recorded = new WeakSet();
		set({ suggestions: {} });
	},
}));
