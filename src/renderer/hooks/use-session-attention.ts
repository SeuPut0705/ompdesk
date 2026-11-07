import { useMemo } from "react";
import { type Attention, sessionAttention } from "../lib/attention";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useOpenedChildren } from "./use-opened-children";
import { useFocusedRun } from "./use-tab-run";

/**
 * What the focused session needs from the person (`sessionAttention`), or null, for the surfaces outside the work
 * board: the title bar, the window title, the dock badge and the tray. By the sidebar row's rule: its own prompt as
 * its summary says it (none while the session is down), else a child of it waiting on an answer. A failed check does
 * not count (the agent fixes it). Stable while the kind and count hold.
 */
export function useSessionAttention(): Attention | null {
	// The pane's tab, else the window's active one (as the board's own `useBoardTabId`).
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const { run } = useFocusedRun();
	const childrenWaiting = useOpenedChildren(tabId).counts.waiting;
	const attention = sessionAttention({
		asks: run.ask ? [run.ask] : [],
		childrenWaiting: run.down ? 0 : childrenWaiting,
	});
	const kind = attention?.kind;
	const count = attention?.count ?? 0;
	return useMemo(() => (kind ? { kind, count } : null), [kind, count]);
}
