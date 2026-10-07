/**
 * Sidebar subagent groups: the user's explicit expand/collapse choice per
 * session (absent = follow liveness: open while any subagent runs), and a
 * one-shot request to reveal a tab's group (expand + scroll + focus).
 * In-memory UI state; a restart starts every group back on liveness.
 */
import { create } from "zustand";
import { useUiStore } from "./ui";

interface SidebarSubagentsStore {
	/** Session path → explicit expanded choice. */
	expanded: Record<string, boolean>;
	/** Pending reveal for the session currently open in `tabId`; `seq` makes repeats distinct. */
	reveal: { tabId: string; seq: number } | null;
	setExpanded: (sessionKey: string, expanded: boolean) => void;
	/** Clear a handled reveal (no-op when a newer one already replaced it). */
	consumeReveal: (seq: number) => void;
}

export const useSidebarSubagentsStore = create<SidebarSubagentsStore>()((set, get) => ({
	expanded: {},
	reveal: null,
	setExpanded: (sessionKey, expanded) => set(state => ({ expanded: { ...state.expanded, [sessionKey]: expanded } })),
	consumeReveal: seq => {
		if (get().reveal?.seq === seq) set({ reveal: null });
	},
}));

/**
 * Show the sidebar (if the user hid it), expand the subagent group under the
 * session open in `tabId`, and scroll it into view with focus on its toggle.
 */
export function revealSidebarSubagents(tabId: string): void {
	if (!useUiStore.getState().sidebarVisible) useUiStore.setState({ sidebarVisible: true });
	useSidebarSubagentsStore.setState(state => ({ reveal: { tabId, seq: (state.reveal?.seq ?? 0) + 1 } }));
}
