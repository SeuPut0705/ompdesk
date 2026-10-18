/**
 * Sidebar families (a session's subagents and the sessions its agent opened, shown as one group under its row):
 * which sessions show their children (collapsed by default), which sessions' subagents the user hid, and a one-shot
 * request to reveal the rows under a tab's session (show the sidebar, expand, scroll, focus the first row).
 *
 * A family is folded until the person opens it and NEVER opens or folds by itself: not when a child starts, runs or
 * finishes (in a long orchestration every follow-up message is a new run). The person's own toggle is remembered per
 * session. The only thing a folded family shows unasked is a child waiting for an answer (one row, see
 * `SidebarSubagents`), which does not touch this state. In-memory UI state: nothing survives a restart.
 */
import { create } from "zustand";
import { useUiStore } from "./ui";

interface SidebarSubagentsStore {
	/** Session paths whose family rows are expanded; absent = collapsed. */
	expanded: ReadonlySet<string>;
	/** Session paths whose subagent rows (and their count in the chip) the user hid. */
	hidden: ReadonlySet<string>;
	/** Session paths that currently have family rows (their disclosures register). */
	present: ReadonlySet<string>;
	/** Pending reveal for the session currently open in `tabId`; `seq` makes repeats distinct. */
	reveal: { tabId: string; seq: number } | null;
	/** Expand or collapse a session's family rows (collapsing drops the entry). */
	setExpanded: (sessionKey: string, open: boolean) => void;
	setHidden: (sessionKey: string, hidden: boolean) => void;
	setPresent: (sessionKey: string, present: boolean) => void;
	expandAll: () => void;
	collapseAll: () => void;
	showAll: () => void;
	/** Clear a handled reveal (no-op when a newer one already replaced it). */
	consumeReveal: (seq: number) => void;
}

function toggled(set: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> | null {
	if (on === set.has(key)) return null;
	const next = new Set(set);
	if (on) next.add(key);
	else next.delete(key);
	return next;
}

export const useSidebarSubagentsStore = create<SidebarSubagentsStore>()((set, get) => ({
	expanded: new Set(),
	hidden: new Set(),
	present: new Set(),
	reveal: null,
	setExpanded: (sessionKey, open) => {
		const next = toggled(get().expanded, sessionKey, open);
		if (next) set({ expanded: next });
	},
	setHidden: (sessionKey, hidden) => {
		const next = toggled(get().hidden, sessionKey, hidden);
		if (next) set({ hidden: next });
	},
	setPresent: (sessionKey, present) => {
		const next = toggled(get().present, sessionKey, present);
		if (next) set({ present: next });
	},
	expandAll: () => set(state => ({ expanded: new Set(state.present) })),
	collapseAll: () => set({ expanded: new Set() }),
	showAll: () => set({ hidden: new Set() }),
	consumeReveal: seq => {
		if (get().reveal?.seq === seq) set({ reveal: null });
	},
}));

/** Flip a session's family rows between expanded and collapsed. */
export function toggleSidebarSubagents(sessionKey: string): void {
	const store = useSidebarSubagentsStore.getState();
	store.setExpanded(sessionKey, !store.expanded.has(sessionKey));
}

/**
 * Show the sidebar (if the user hid it), un-hide and expand the subagent rows
 * under the session open in `tabId`, scroll them into view and focus the first one.
 */
export function revealSidebarSubagents(tabId: string): void {
	if (!useUiStore.getState().sidebarVisible) useUiStore.setState({ sidebarVisible: true });
	useSidebarSubagentsStore.setState(state => ({ reveal: { tabId, seq: (state.reveal?.seq ?? 0) + 1 } }));
}
