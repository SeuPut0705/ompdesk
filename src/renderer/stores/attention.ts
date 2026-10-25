import { create } from "zustand";

/**
 * Which tabs' newest check failed, for `sessionAttention` beyond the work board: the board's lazy session chunk
 * (`FailedCheckWatch`, `WorkBoardSession.tsx`) works it out and writes it here, and the board, the strip, the title
 * bar, the sidebar row, the window title and the tray read it. A tab whose board is not mounted has no entry.
 */
interface AttentionStore {
	checkFailed: Readonly<Record<string, true>>;
	setCheckFailed(tabId: string, failed: boolean): void;
}

export const useAttentionStore = create<AttentionStore>(set => ({
	checkFailed: {},
	setCheckFailed: (tabId, failed) =>
		set(state => {
			if (Object.hasOwn(state.checkFailed, tabId) === failed) return state;
			const { [tabId]: _, ...rest } = state.checkFailed;
			return { checkFailed: failed ? { ...rest, [tabId]: true } : rest };
		}),
}));

export function useCheckFailed(tabId: string | null): boolean {
	return useAttentionStore(state => tabId !== null && Object.hasOwn(state.checkFailed, tabId));
}
