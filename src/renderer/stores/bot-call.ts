/**
 * Which bot tab has a voice call on (at most one per window; `lib/voice-call.ts` runs it, `BotCallBar` is its view).
 * The bar's mount is the call: the Voice chat button sets the tab here, the bar starts the call when it mounts, and
 * ends it when it unmounts or its End button clears the tab. While the call's reply plays, `speaking` is on and the
 * playback level goes out on {@link publishCallLevel}, which the speaking avatar reads without a React render.
 */
import { create } from "zustand";

interface BotCallStore {
	tabId: string | null;
	/** The reply of the call on `tabId` is playing. */
	speaking: boolean;
	start: (tabId: string) => void;
	/** Clears the call of `tabId` only: another tab's call is not this one's to end. */
	end: (tabId: string) => void;
	/** Sets `speaking` for the call of `tabId` only. */
	setSpeaking: (tabId: string, speaking: boolean) => void;
}

export const useBotCallStore = create<BotCallStore>()(set => ({
	tabId: null,
	speaking: false,
	start: tabId => set({ tabId, speaking: false }),
	end: tabId => set(state => (state.tabId === tabId ? { tabId: null, speaking: false } : state)),
	setSpeaking: (tabId, speaking) =>
		set(state => (state.tabId === tabId && state.speaking !== speaking ? { speaking } : state)),
}));

const levelListeners = new Set<(level: number) => void>();

/** The playback level of the bot's spoken reply, 0..1, a few times a second; 0 when nothing plays. */
export function publishCallLevel(level: number): void {
	for (const listener of levelListeners) listener(level);
}

/** Listen to {@link publishCallLevel}; returns the unsubscribe. Not a store: a level must not render anything. */
export function subscribeCallLevel(listener: (level: number) => void): () => void {
	levelListeners.add(listener);
	return () => levelListeners.delete(listener);
}
