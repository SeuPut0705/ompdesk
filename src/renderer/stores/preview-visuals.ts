/**
 * C135: visuals the agent's `gui_visualize` showed, waiting for the Preview
 * panel of their tab. Main sends one event per open; the panel of that tab
 * shows them (now when it is mounted, else the next time it is).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { useTabsStore } from "./tabs";
import { useUiStore } from "./ui";

interface PreviewVisualsState {
	/** Visual ids per tab, oldest first, not yet shown by that tab's panel. */
	pending: Record<string, string[]>;
	add: (tabId: string, visualId: string) => void;
	/** Take (and forget) one tab's pending visuals. */
	take: (tabId: string) => string[];
	reset: () => void;
}

export const usePreviewVisualsStore = create<PreviewVisualsState>((set, get) => ({
	pending: {},
	add: (tabId, visualId) =>
		set(state => ({
			pending: {
				...state.pending,
				[tabId]: [...(state.pending[tabId] ?? []).filter(id => id !== visualId), visualId],
			},
		})),
	take: tabId => {
		const ids = get().pending[tabId] ?? [];
		if (ids.length > 0) {
			const { [tabId]: _taken, ...rest } = get().pending;
			set({ pending: rest });
		}
		return ids;
	},
	reset: () => set({ pending: {} }),
}));

/** App-level: queue each shown visual for its tab and bring the Preview forward when that tab is in front. */
export function usePreviewVisualEvents(): void {
	useEffect(
		() =>
			window.omp.preview.onVisual(({ tabId, visualId }) => {
				usePreviewVisualsStore.getState().add(tabId, visualId);
				if (useTabsStore.getState().activeTabId === tabId) useUiStore.getState().setPanelTab("preview");
			}),
		[],
	);
}
