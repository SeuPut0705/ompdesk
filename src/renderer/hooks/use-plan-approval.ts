/**
 * Plan-approval subscription hook: captures `plan_proposal` frames from the
 * batched agent event stream into the plan-approval store. The sidecar emits
 * a proposal when the agent submits a plan (a `write` to `xd://propose` while
 * plan mode is active), silently stops the proposal turn, and waits for the
 * host's `plan_approval` answer. Rapid successive proposals replace each
 * other — only the latest is kept. A hidden tab's proposal lands in that
 * tab's own store (its sidebar row asks for approval); one this renderer
 * missed is re-shown by the tab's hydrate (`syncPlanProposal`).
 */

import { useEffect } from "react";
import type { AgentSessionEvent } from "../../shared/rpc-types";
import { usePlanApprovalStore } from "../stores/plan-approval";
import { withSessionRuntime } from "../stores/session-runtime-context";
import { isTabClosed } from "../stores/tabs";

export function usePlanApproval(): void {
	useEffect(() => {
		const reduce = (events: AgentSessionEvent[], tabId: string) => {
			if (isTabClosed(tabId)) return;
			withSessionRuntime(tabId, () => {
				for (const event of events) {
					const store = usePlanApprovalStore.getState();
					if (event.type === "plan_proposal_resolved") {
						// Answered elsewhere (another window, a device, an agent) or replied to by a prompt. With this
						// window's own answer in flight, its outcome settles the card (a loser's failure then closes it).
						if (store.pending?.planFilePath !== event.planFilePath) continue;
						if (store.submitting) usePlanApprovalStore.setState({ resolved: true });
						else store.clearProposal();
						continue;
					}
					if (event.type !== "plan_proposal") continue;
					store.showProposal({
						planFilePath: event.planFilePath,
						title: event.title,
						suggestedFileName: event.suggestedFileName,
						planContent: event.planContent,
						options: event.options,
					});
				}
			});
		};
		return window.omp.events.onTabBatch(reduce);
	}, []);
}
