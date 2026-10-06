import { BLOCKING_UI_METHODS } from "../../shared/rpc-types";
import { useExtensionUiStore } from "../stores/extension-ui";
import { usePlanApprovalStore } from "../stores/plan-approval";

/**
 * True while the attached session blocks on a user confirmation — plan
 * approval, ask, or a permission prompt. Shared by the sidebar signal light
 * and the window-title run-state marker.
 */
export function useAwaitingConfirmation(): boolean {
	const planApprovalPending = usePlanApprovalStore(s => s.pending != null);
	const extensionInputPending = useExtensionUiStore(s =>
		s.pendingRequests.some(request => BLOCKING_UI_METHODS[request.method] === true),
	);
	return planApprovalPending || extensionInputPending;
}
