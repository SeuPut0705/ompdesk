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
 * comes back. It never undoes what happened on this page meanwhile, and it
 * orders nothing by two computers' clocks (a paired host's may be minutes
 * off): a suggestion is told from the one this page let go by its identity,
 * and a read from what the page did meanwhile by this page's own clock.
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
	/** The bridge's identity for it (absent for the legacy widget and an older bridge). */
	id?: string;
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
	 * `since` (this page's clock). Ignored when this page recorded a frame for the session or let it go (the person
	 * sent something, a run began) after the read started, and when it is the very suggestion this page let go (by
	 * its `id`; an older bridge's by its text): it never brings back what the page already let go. `last.at` is the
	 * other computer's clock and is never compared. Candidates replace the entry; none drop it.
	 */
	recordLast: (sessionKey: string, last: NextPromptLast, since: number) => void;
	/** Forget the suggestion of every given session key. */
	clear: (...sessionKeys: (string | null | undefined)[]) => void;
	reset: () => void;
}

/** Widget line arrays and update frames already recorded (each publication is a fresh object). */
let recorded = new WeakSet<object>();

/** When each session's suggestion was last let go on this page (a submit, a run): a read started before can't undo it. */
const clearedAt = new Map<string, number>();
/** The suggestions this page let go, per session, by identity: no later read brings one back. */
const letGo = new Map<string, string[]>();
/** Identities of let-go suggestions remembered per session. */
const LET_GO_KEPT = 8;

/** A suggestion's identity: the bridge's id, else (an older bridge, the legacy widget) its text. */
function identityOf(suggestion: { id?: string; candidates: readonly string[] }): string {
	return suggestion.id ? `id:${suggestion.id}` : `text:${JSON.stringify(suggestion.candidates)}`;
}

function noteCleared(sessionKey: string, at: number, entry: StoredSuggestion | undefined): void {
	clearedAt.delete(sessionKey);
	clearedAt.set(sessionKey, at);
	if (entry) {
		const identities = [...(letGo.get(sessionKey) ?? []), identityOf(entry)].slice(-LET_GO_KEPT);
		letGo.delete(sessionKey);
		letGo.set(sessionKey, identities);
	}
	for (const map of [clearedAt, letGo])
		for (const stale of [...map.keys()].slice(0, Math.max(0, map.size - MAX_SESSIONS * 2))) map.delete(stale);
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
		set({
			suggestions: remember(get().suggestions, sessionKey, {
				candidates,
				used: update.used,
				at: Date.now(),
				...(update.id ? { id: update.id } : {}),
			}),
		});
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
		// Let go on this page while the read ran: the answer may be the suggestion the page just let go.
		if ((clearedAt.get(sessionKey) ?? Number.NEGATIVE_INFINITY) >= since) return;
		if (letGo.get(sessionKey)?.includes(identityOf(last))) return;
		const candidates = last.candidates.filter(text => text.trim() !== "");
		if (candidates.length === 0) {
			if (entry) get().clear(sessionKey);
			return;
		}
		set({
			suggestions: remember(get().suggestions, sessionKey, {
				candidates,
				used: last.used,
				at: Date.now(),
				...(last.id ? { id: last.id } : {}),
			}),
		});
	},
	clear: (...sessionKeys) => {
		const now = Date.now();
		for (const key of sessionKeys) if (key) noteCleared(key, now, get().suggestions[key]);
		const keys = sessionKeys.filter((key): key is string => !!key && key in get().suggestions);
		if (keys.length === 0) return;
		const suggestions = { ...get().suggestions };
		for (const key of keys) delete suggestions[key];
		set({ suggestions });
	},
	reset: () => {
		recorded = new WeakSet();
		clearedAt.clear();
		letGo.clear();
		set({ suggestions: {} });
	},
}));
