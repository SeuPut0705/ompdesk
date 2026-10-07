/**
 * Sidebar subagent rows: which sessions show their live subagent rows
 * (collapsed by default) and a one-shot request to reveal the rows under a
 * tab's session (show the sidebar, expand, scroll, focus the first row).
 * In-memory UI state: nothing survives a restart.
 */
import { create } from "zustand";
import { useUiStore } from "./ui";

interface SidebarSubagentsStore {
	/** Session paths whose subagent rows are expanded; absent = collapsed. */
	expanded: ReadonlySet<string>;
	/** Pending reveal for the session currently open in `tabId`; `seq` makes repeats distinct. */
	reveal: { tabId: string; seq: number } | null;
	/** Expand or collapse a session's subagent rows (collapsing drops the entry). */
	setExpanded: (sessionKey: string, open: boolean) => void;
	/** Clear a handled reveal (no-op when a newer one already replaced it). */
	consumeReveal: (seq: number) => void;
}

export const useSidebarSubagentsStore = create<SidebarSubagentsStore>()((set, get) => ({
	expanded: new Set(),
	reveal: null,
	setExpanded: (sessionKey, open) => {
		const { expanded } = get();
		if (open === expanded.has(sessionKey)) return;
		const next = new Set(expanded);
		if (open) next.add(sessionKey);
		else next.delete(sessionKey);
		set({ expanded: next });
	},
	consumeReveal: seq => {
		if (get().reveal?.seq === seq) set({ reveal: null });
	},
}));

/** Flip a session's subagent rows between expanded and collapsed. */
export function toggleSidebarSubagents(sessionKey: string): void {
	const store = useSidebarSubagentsStore.getState();
	store.setExpanded(sessionKey, !store.expanded.has(sessionKey));
}

/**
 * Show the sidebar (if the user hid it), expand the live subagent rows under
 * the session open in `tabId`, scroll them into view and focus the first one.
 */
export function revealSidebarSubagents(tabId: string): void {
	if (!useUiStore.getState().sidebarVisible) useUiStore.setState({ sidebarVisible: true });
	useSidebarSubagentsStore.setState(state => ({ reveal: { tabId, seq: (state.reveal?.seq ?? 0) + 1 } }));
}
