import { useMemo } from "react";
import { type Attention, pendingAsks, sessionAttention } from "../lib/attention";
import { useExtensionUiStore } from "../stores/extension-ui";
import { usePlanApprovalStore } from "../stores/plan-approval";
import { useRuntimeTabId } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { useOpenedChildren } from "./use-opened-children";

/**
 * What the attached session needs from the person (`sessionAttention`), or null, for the surfaces outside the work
 * board: the title bar, the sidebar row, the window title, the dock badge and the tray. Its own question or approval
 * and a child waiting on an answer count; a failed check does not (the agent fixes it). Stable while the kind and
 * count hold.
 */
export function useSessionAttention(): Attention | null {
	// The pane's tab, else the window's active one (as the board's own `useBoardTabId`).
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const pendingRequests = useExtensionUiStore(state => state.pendingRequests);
	const loginRequestIds = useExtensionUiStore(state => state.loginRequestIds);
	const planPending = usePlanApprovalStore(state => state.pending !== null);
	const childrenWaiting = useOpenedChildren(tabId).counts.waiting;
	const attention = sessionAttention({
		asks: pendingAsks({ pendingRequests, loginRequestIds }, planPending),
		childrenWaiting,
	});
	const kind = attention?.kind;
	const count = attention?.count ?? 0;
	return useMemo(() => (kind ? { kind, count } : null), [kind, count]);
}
