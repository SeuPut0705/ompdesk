/**
 * Opened sessions main closed after their work landed (`ClosedChild`, pref `agentClosedChildren`, written by main): the
 * session file stays, and the opener's family keeps them behind its "n done" row. Read once and again whenever main
 * says the pref changed; the sidebar reads it for provenance, since a closed tab no longer names its opener.
 */
import { create } from "zustand";
import { AGENT_CLOSED_CHILDREN_PREF, type ClosedChild, parseClosedChildren } from "../../shared/agent-control";
import { readPref } from "../lib/prefs-read";

interface ClosedChildrenStore {
	rows: readonly ClosedChild[];
	load: () => Promise<void>;
	reset: () => void;
}

export const useClosedChildrenStore = create<ClosedChildrenStore>()(set => ({
	rows: [],
	load: async () => {
		const read = await readPref(AGENT_CLOSED_CHILDREN_PREF);
		if (read.ok) set({ rows: parseClosedChildren(read.value) });
	},
	reset: () => set({ rows: [] }),
}));

let subscribed = false;

/** Load the list and follow main's changes; a missing bridge (tests) is skipped. */
export function ensureClosedChildren(): void {
	if (subscribed || typeof window === "undefined" || typeof window.omp?.prefs?.get !== "function") return;
	subscribed = true;
	void useClosedChildrenStore.getState().load();
	window.omp.prefs.onChanged?.(event => {
		if (event.key === AGENT_CLOSED_CHILDREN_PREF) void useClosedChildrenStore.getState().load();
	});
}
