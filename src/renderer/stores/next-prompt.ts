import { create } from "zustand";
import { parseNextPrompt } from "../lib/next-prompt";
import { useTabsStore } from "./tabs";

/**
 * GUI-owned memory of the `next-prompt` extension's suggestion, per session.
 *
 * The extension clears its widget on input, agent_start and session_start, and
 * the renderer wipes extension widgets on every session switch, so the widget
 * alone cannot outlive a switch or a deleted draft. This store keeps the last
 * suggestion for each session (session file path, else session id) until it
 * is genuinely stale: the user submits in that session, a run starts there, or
 * a newer suggestion replaces it. The extension's own clears are ignored.
 */

/** Sessions remembered at once; the least recently recorded drop first. */
const MAX_SESSIONS = 50;

export interface NextPromptStore {
	/** Suggestion per session key, oldest record first. */
	suggestions: Record<string, string>;
	/** Record a `next-prompt` widget publication for a session. Each published
	 * line array counts once, so a remount never resurrects a suggestion the
	 * user already consumed; empty widgets (the extension's clears) are ignored. */
	recordWidget: (sessionKey: string, lines: readonly string[] | undefined) => void;
	/** Forget the suggestion of every given session key. */
	clear: (...sessionKeys: (string | null | undefined)[]) => void;
	reset: () => void;
}

/** Widget line arrays already recorded (each publication is a fresh array). */
let recorded = new WeakSet<readonly string[]>();

export const useNextPromptStore = create<NextPromptStore>()((set, get) => ({
	suggestions: {},
	recordWidget: (sessionKey, lines) => {
		if (!lines || recorded.has(lines)) return;
		recorded.add(lines);
		const text = parseNextPrompt(lines);
		if (text === undefined) return;
		const { [sessionKey]: _previous, ...rest } = get().suggestions;
		const keys = Object.keys(rest);
		for (const key of keys.slice(0, Math.max(0, keys.length - (MAX_SESSIONS - 1)))) delete rest[key];
		set({ suggestions: { ...rest, [sessionKey]: text } });
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

// A run starting in any tab — background ones included, whose agent_start
// never reaches the renderer — makes that session's suggestion stale.
useTabsStore.subscribe((next, previous) => {
	if (next.tabs === previous.tabs) return;
	for (const tab of next.tabs) {
		if (tab.status !== "running") continue;
		if (previous.tabs.find(prior => prior.id === tab.id)?.status === "running") continue;
		useNextPromptStore.getState().clear(tab.sessionPath, tab.sessionId);
	}
});
