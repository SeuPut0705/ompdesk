import { create } from "zustand";
import type {
	NextPromptLast,
	NextPromptModelUsed,
	NextPromptUpdate,
} from "../../../resources/gui-bridge/modes/next-prompt-contracts";
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
 *
 * A third source fills in what a page missed: every hydration reads the
 * session's last suggestion from its bridge (`get_next_prompt` → `last`,
 * `recordLast`), so a frame that never reached this page (its tab was in the
 * background, a reload, a hidden phone, a paired host's lost link, a relaunch)
 * comes back. It never undoes what happened on this page meanwhile.
 */

/** Sessions remembered at once; the least recently recorded drop first. */
const MAX_SESSIONS = 50;

/** One session's remembered suggestion: ranked candidates, best first. */
export interface StoredSuggestion {
	candidates: string[];
	/** Model the built-in request ran on; absent for the legacy widget. */
	used?: NextPromptModelUsed;
	/** Epoch ms it was recorded on this page. */
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
	/**
	 * Apply the session's last suggestion a hydration read (`get_next_prompt` → `last`), the read having started at
	 * `since` (this page's clock). Ignored when this page recorded a frame for the session after the read started
	 * (it is newer) or cleared it after the suggestion was made (the person sent something, a run began): it never
	 * brings back what the page already let go. Candidates replace the entry; none drop it.
	 */
	recordLast: (sessionKey: string, last: NextPromptLast, since: number) => void;
	/** Forget the suggestion of every given session key. */
	clear: (...sessionKeys: (string | null | undefined)[]) => void;
	reset: () => void;
}

/** Widget line arrays and update frames already recorded (each publication is a fresh object). */
let recorded = new WeakSet<object>();

/** When each session's suggestion was last let go on this page (a submit, a run): a read made before can't undo it. */
const clearedAt = new Map<string, number>();

function noteCleared(sessionKey: string, at: number): void {
	clearedAt.delete(sessionKey);
	clearedAt.set(sessionKey, at);
	for (const stale of [...clearedAt.keys()].slice(0, Math.max(0, clearedAt.size - MAX_SESSIONS * 2)))
		clearedAt.delete(stale);
}

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
	recordLast: (sessionKey, last, since) => {
		const entry = get().suggestions[sessionKey];
		if (entry && entry.at >= since) return;
		// Made before this page let the session's suggestion go: stale. (`last.at` is the clock of the computer the
		// session runs on; a paired computer's is close enough for a moment that spans a whole turn.)
		if ((clearedAt.get(sessionKey) ?? Number.NEGATIVE_INFINITY) >= last.at) return;
		const candidates = last.candidates.filter(text => text.trim() !== "");
		if (candidates.length === 0) {
			if (entry) get().clear(sessionKey);
			return;
		}
		set({ suggestions: remember(get().suggestions, sessionKey, { candidates, used: last.used, at: Date.now() }) });
	},
	clear: (...sessionKeys) => {
		const now = Date.now();
		for (const key of sessionKeys) if (key) noteCleared(key, now);
		const keys = sessionKeys.filter((key): key is string => !!key && key in get().suggestions);
		if (keys.length === 0) return;
		const suggestions = { ...get().suggestions };
		for (const key of keys) delete suggestions[key];
		set({ suggestions });
	},
	reset: () => {
		recorded = new WeakSet();
		clearedAt.clear();
		set({ suggestions: {} });
	},
}));
