/**
 * Whether the owner has the bot on (pref `botEnabled`, Settings › Bot; off by default) and its session file (pref
 * `bot`, written by main alone: `agent-control/bot-home.ts`). Read once and again whenever main says either changed.
 * `path` is null while the bot is off, and until main has made the session (the first seconds after it is turned on
 * or a launch), when the sidebar's bot row still shows and asks main for it on a click.
 */
import { create } from "zustand";
import { BOT_ENABLED_PREF, BOT_PREF, botEnabled, botPathOf } from "../../shared/agent-control";
import { saveGuiPreference } from "../lib/display-preferences";
import { readPref } from "../lib/prefs-read";

interface BotStore {
	enabled: boolean;
	path: string | null;
	load: () => Promise<void>;
	/**
	 * Settings › Bot's switch. Main tells every other window (`PREFS_CHANGED`), never the one that wrote it, so this
	 * window's own row follows from here.
	 */
	setEnabled: (next: boolean) => Promise<void>;
	reset: () => void;
}

export const useBotStore = create<BotStore>()((set, get) => ({
	enabled: false,
	path: null,
	load: async () => {
		const [enabled, path] = await Promise.all([readPref(BOT_ENABLED_PREF), readPref(BOT_PREF)]);
		if (!enabled.ok || !path.ok) return;
		const on = botEnabled(enabled.value);
		set({ enabled: on, path: on ? botPathOf(path.value) : null });
	},
	setEnabled: async next => {
		if (await saveGuiPreference(BOT_ENABLED_PREF, next, () => set({ enabled: next, path: next ? get().path : null })))
			await get().load();
	},
	reset: () => set({ enabled: false, path: null }),
}));

let subscribed = false;

/** Load both prefs and follow main's changes; a missing bridge (tests) is skipped. */
export function ensureBotPath(): void {
	if (subscribed || typeof window === "undefined" || typeof window.omp?.prefs?.get !== "function") return;
	subscribed = true;
	void useBotStore.getState().load();
	window.omp.prefs.onChanged?.(event => {
		if (event.key === BOT_PREF || event.key === BOT_ENABLED_PREF) void useBotStore.getState().load();
	});
}
