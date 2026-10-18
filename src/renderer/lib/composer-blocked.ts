/**
 * What the session waits on the user for, as the composer's placeholder wants to say it: a question (`ask`), a
 * tool approval (`approval`) or a plan proposal (`plan`). Derived from the stores that already hold them
 * (extension-ui's pending requests, plan-approval's proposal), so nothing new is tracked. The composer stays
 * usable meanwhile (typing adds a steer or a plain message); this only names what the card above is asking.
 */
import { type AwaitedInput, awaitedInput, useExtensionUiStore } from "../stores/extension-ui";
import { usePlanApprovalStore } from "../stores/plan-approval";

export type ComposerBlocker = "ask" | "approval" | "plan";

/** Locale key of the placeholder for each blocker (`input.placeholder.blocked*`). */
export const COMPOSER_BLOCKED_PLACEHOLDER: Record<ComposerBlocker, string> = {
	ask: "input.placeholder.blockedAsk",
	approval: "input.placeholder.blockedApproval",
	plan: "input.placeholder.blockedPlan",
};

/** An approval beats a question (the turn cannot go on without it); a plan proposal waits behind both. */
export function composerBlockedBy(awaited: AwaitedInput | null, planPending: boolean): ComposerBlocker | null {
	if (awaited === "approval") return "approval";
	if (awaited === "input") return "ask";
	return planPending ? "plan" : null;
}

/** The pane's blocker, re-rendering the caller only when it changes. */
export function useComposerBlockedBy(): ComposerBlocker | null {
	const awaited = useExtensionUiStore(awaitedInput);
	const planPending = usePlanApprovalStore(state => state.pending !== null);
	return composerBlockedBy(awaited, planPending);
}
