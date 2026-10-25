import { useMemo } from "react";
import { type Attention, pendingAsks, sessionAttention } from "../lib/attention";
import { useCheckFailed } from "../stores/attention";
import { useExtensionUiStore } from "../stores/extension-ui";
import { usePlanApprovalStore } from "../stores/plan-approval";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useOpenedChildren } from "./use-opened-children";

/**
 * What the attached session needs from the person (`sessionAttention`), or null: its own question or approval, a
 * session it opened waiting on an answer, or its failed check. Read by the sidebar row, the title bar, the window
 * title, the dock badge and the tray; stable while the kind and count hold.
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
	const checkFailed = useCheckFailed(tabId);
	const attention = sessionAttention({
		asks: pendingAsks({ pendingRequests, loginRequestIds }, planPending),
		childrenWaiting,
		checkFailed,
	});
	const kind = attention?.kind;
	const count = attention?.count ?? 0;
	return useMemo(() => (kind ? { kind, count } : null), [kind, count]);
}
