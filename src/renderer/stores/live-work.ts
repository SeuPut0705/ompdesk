import { create } from "zustand";

/** Transcript-owned context handoff, independent of virtualized card mounts. */
interface LiveWorkStore {
	cards: Readonly<Record<string, boolean>>;
	setCarried: (tabId: string, carried: boolean) => void;
	reset: () => void;
}

export const useLiveWorkStore = create<LiveWorkStore>()(set => ({
	cards: {},
	setCarried: (tabId, carried) =>
		set(state => {
			if ((state.cards[tabId] ?? false) === carried) return state;
			const { [tabId]: _removed, ...rest } = state.cards;
			return { cards: carried ? { ...rest, [tabId]: true } : rest };
		}),
	reset: () => set({ cards: {} }),
}));

export function liveWorkKey(tabId: string | null): string {
	return tabId ?? "";
}
