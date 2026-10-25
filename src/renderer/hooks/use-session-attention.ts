import { useMemo } from "react";
import { type Attention, pendingAsks, sessionAttention, sessionWorking } from "../lib/attention";
import { useCheckFailed } from "../stores/attention";
import { useExtensionUiStore } from "../stores/extension-ui";
import { usePlanApprovalStore } from "../stores/plan-approval";
import { useSessionStore } from "../stores/session";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useOpenedChildren } from "./use-opened-children";

/**
 * What the attached session needs from the person (`sessionAttention`), or null, for the surfaces outside the work
 * board: the title bar, the sidebar row, the window title, the dock badge and the tray. Its own question or approval
 * and a child waiting on an answer always count. A failed check counts only while the session is idle: a turn that
 * runs (or compacts, or retries) is the agent's to fix, so those surfaces say it works, and only the board lists the
 * check meanwhile (the root's call, 25 Oct 2026). Stable while the kind and count hold.
 */
export function useSessionAttention(): Attention | null {
	// The pane's tab, else the window's active one (as the board's own `useBoardTabId`), so both read one entry.
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const pendingRequests = useExtensionUiStore(state => state.pendingRequests);
	const loginRequestIds = useExtensionUiStore(state => state.loginRequestIds);
	const planPending = usePlanApprovalStore(state => state.pending !== null);
	const childrenWaiting = useOpenedChildren(tabId).counts.waiting;
	const working = useSessionStore(sessionWorking);
	const checkFailed = useCheckFailed(tabId) && !working;
	const attention = sessionAttention({
		asks: pendingAsks({ pendingRequests, loginRequestIds }, planPending),
		childrenWaiting,
		checkFailed,
	});
	const kind = attention?.kind;
	const count = attention?.count ?? 0;
	return useMemo(() => (kind ? { kind, count } : null), [kind, count]);
}
