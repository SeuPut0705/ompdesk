import { useCallback, useMemo } from "react";
import { splitTabIds } from "../../../../shared/split-layout";
import { useShownSplit } from "../../../hooks/use-shown-split";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

export interface RowSelection {
	/** The row's tab is the focused one. */
	current: boolean;
	/** The row's tab is another pane of the split on screen. */
	inSplit: boolean;
	/** The row reads as selected: its tab is on screen (focused or a pane of the split) and a session is shown. */
	selected: boolean;
	/** A split is on screen (a drawer shell shows the focused tab alone, whatever split the window keeps). */
	splitShown: boolean;
}

/**
 * Which row is selected, for every list of the sidebar (this computer's rows, a family's, a loose child's, a paired
 * computer's section, the phone page's): the one identity is the tab a row's session is open in, against the tab list's
 * focused tab and the split the window shows (`useShownSplit`, the rule `SplitWorkspace` draws by). No row is selected
 * by its position, its session id or any other store.
 */
export function useRowSelection(): (tabId: string | undefined) => RowSelection {
	const activeTabId = useTabsStore(state => state.activeTabId);
	const split = useShownSplit();
	const shown = useUiStore(state => state.destination === "session");
	const panes = useMemo(() => (split ? new Set(splitTabIds(split)) : null), [split]);
	return useCallback(
		tabId => {
			const current = tabId !== undefined && tabId === activeTabId;
			const inSplit = !current && tabId !== undefined && panes?.has(tabId) === true;
			return { current, inSplit, selected: (current || inSplit) && shown, splitShown: panes !== null };
		},
		[activeTabId, panes, shown],
	);
}

/**
 * One info line in the runtime log (`gui-runtime.jsonl`, source `sidebar`) per session a person picks in the sidebar:
 * which list, whether it focused an open tab, re-rooted the empty one or opened a new one, what the row was, the
 * session of the row clicked (`session` id, `file`) and the session the pick selects (`selected`: the file of the tab it
 * focuses, else the row's own file, which the opened tab loads). A pick that selected another session than the row's
 * reads back from the log alone. Main logs every order the sidebar saves beside it.
 */
export function logSelection(
	details: Record<string, string | boolean>,
	picked: { id: string; path: string },
	owner: { sessionPath?: string; sessionId?: string } | undefined,
): void {
	const file = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
	const selected =
		owner === undefined ? file(picked.path) : owner.sessionPath ? file(owner.sessionPath) : owner.sessionId;
	window.omp?.runtime?.report({
		source: "sidebar",
		message: "select",
		details: { level: "info", ...details, session: picked.id, file: file(picked.path), selected: selected ?? "none" },
	});
}
