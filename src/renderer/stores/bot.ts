/**
 * The bot's session file (pref `bot`, written by main alone: `agent-control/bot-home.ts`). Read once and again whenever
 * main says the pref changed; null until main has made the session (the first seconds of a launch), when the sidebar's
 * bot row still shows and asks main for it on a click.
 */
import { create } from "zustand";
import { BOT_PREF, botPathOf } from "../../shared/agent-control";
import { readPref } from "../lib/prefs-read";

interface BotStore {
	path: string | null;
	load: () => Promise<void>;
	reset: () => void;
}

export const useBotStore = create<BotStore>()(set => ({
	path: null,
	load: async () => {
		const read = await readPref(BOT_PREF);
		if (read.ok) set({ path: botPathOf(read.value) });
	},
	reset: () => set({ path: null }),
}));

let subscribed = false;

/** Load the path and follow main's changes; a missing bridge (tests) is skipped. */
export function ensureBotPath(): void {
	if (subscribed || typeof window === "undefined" || typeof window.omp?.prefs?.get !== "function") return;
	subscribed = true;
	void useBotStore.getState().load();
	window.omp.prefs.onChanged?.(event => {
		if (event.key === BOT_PREF) void useBotStore.getState().load();
	});
}
