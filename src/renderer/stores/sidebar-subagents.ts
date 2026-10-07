/**
 * Sidebar subagent rows: a one-shot request to reveal the live subagent rows
 * under a tab's session (show the sidebar, scroll, focus the first row).
 * In-memory UI state.
 */
import { create } from "zustand";
import { useUiStore } from "./ui";

interface SidebarSubagentsStore {
	/** Pending reveal for the session currently open in `tabId`; `seq` makes repeats distinct. */
	reveal: { tabId: string; seq: number } | null;
	/** Clear a handled reveal (no-op when a newer one already replaced it). */
	consumeReveal: (seq: number) => void;
}

export const useSidebarSubagentsStore = create<SidebarSubagentsStore>()((set, get) => ({
	reveal: null,
	consumeReveal: seq => {
		if (get().reveal?.seq === seq) set({ reveal: null });
	},
}));

/**
 * Show the sidebar (if the user hid it) and scroll the live subagent rows
 * under the session open in `tabId` into view, focusing the first one.
 */
export function revealSidebarSubagents(tabId: string): void {
	if (!useUiStore.getState().sidebarVisible) useUiStore.setState({ sidebarVisible: true });
	useSidebarSubagentsStore.setState(state => ({ reveal: { tabId, seq: (state.reveal?.seq ?? 0) + 1 } }));
}
