/**
 * Which bot tab has a voice call on (at most one per window; `lib/voice-call.ts` runs it, `BotCallBar` is its view).
 * The bar's mount is the call: the Voice chat button sets the tab here, the bar starts the call when it mounts, and
 * ends it when it unmounts or its End button clears the tab.
 */
import { create } from "zustand";

interface BotCallStore {
	tabId: string | null;
	start: (tabId: string) => void;
	/** Clears the call of `tabId` only: another tab's call is not this one's to end. */
	end: (tabId: string) => void;
}

export const useBotCallStore = create<BotCallStore>()(set => ({
	tabId: null,
	start: tabId => set({ tabId }),
	end: tabId => set(state => (state.tabId === tabId ? { tabId: null } : state)),
}));
