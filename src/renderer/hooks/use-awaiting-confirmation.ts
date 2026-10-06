import { BLOCKING_UI_METHODS } from "../../shared/rpc-types";
import { isInlineLoginRequest, useExtensionUiStore } from "../stores/extension-ui";
import { usePlanApprovalStore } from "../stores/plan-approval";

/**
 * True while the attached session blocks on a user confirmation — plan
 * approval, ask, or a permission prompt. Shared by the sidebar signal light
 * and the window-title run-state marker.
 */
export function useAwaitingConfirmation(): boolean {
	const planApprovalPending = usePlanApprovalStore(s => s.pending != null);
	// A provider sign-in answered inline is the user's own action, not the
	// session waiting on them.
	const extensionInputPending = useExtensionUiStore(s =>
		s.pendingRequests.some(
			request => BLOCKING_UI_METHODS[request.method] === true && !(s.inlineLogin && isInlineLoginRequest(request)),
		),
	);
	return planApprovalPending || extensionInputPending;
}
