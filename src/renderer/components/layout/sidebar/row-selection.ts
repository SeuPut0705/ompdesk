import { useCallback, useMemo } from "react";
import { splitTabIds } from "../../../../shared/split-layout";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

export interface RowSelection {
	/** The row's tab is the focused one. */
	current: boolean;
	/** The row's tab is another pane of the split on screen. */
	inSplit: boolean;
	/** The row reads as selected: its tab is on screen (focused or a pane of the split) and a session is shown. */
	selected: boolean;
}

/**
 * Which row is selected, for every list of the sidebar (this computer's rows, a family's, a loose child's, a paired
 * computer's section, the phone page's): the one identity is the tab a row's session is open in, against the tab list's
 * focused tab and split. No row is selected by its position, its session id or any other store.
 */
export function useRowSelection(): (tabId: string | undefined) => RowSelection {
	const activeTabId = useTabsStore(state => state.activeTabId);
	const split = useTabsStore(state => state.split);
	const shown = useUiStore(state => state.destination === "session");
	const panes = useMemo(() => (split ? new Set(splitTabIds(split)) : null), [split]);
	return useCallback(
		tabId => {
			const current = tabId !== undefined && tabId === activeTabId;
			const inSplit = !current && tabId !== undefined && panes?.has(tabId) === true;
			return { current, inSplit, selected: (current || inSplit) && shown };
		},
		[activeTabId, panes, shown],
	);
}

/**
 * One info line in the runtime log (`gui-runtime.jsonl`, source `sidebar`) per session a person picks in the sidebar:
 * which list, whether it focused an open tab, re-rooted the empty one or opened a new one, and what the row was. Main
 * logs every order the sidebar saves beside it, so a report of a list that moved under a click can be read back.
 */
export function logSelection(details: Record<string, string | boolean>): void {
	window.omp?.runtime?.report({ source: "sidebar", message: "select", details: { level: "info", ...details } });
}
