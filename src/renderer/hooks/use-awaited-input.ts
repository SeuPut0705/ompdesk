import { type AwaitedInput, awaitedInput, useExtensionUiStore } from "../stores/extension-ui";
import { usePlanApprovalStore } from "../stores/plan-approval";

/**
 * What the attached session blocks on, or null: `approval` for a tool approval
 * or a plan proposal, `input` for any other answer (ask, select, confirm, …).
 * Shared by the sidebar signal, the title bar, the window title and the tray.
 */
export function useAwaitedInput(): AwaitedInput | null {
	const planApprovalPending = usePlanApprovalStore(s => s.pending != null);
	const extensionInput = useExtensionUiStore(awaitedInput);
	return extensionInput ?? (planApprovalPending ? "approval" : null);
}
