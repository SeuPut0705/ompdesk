/**
 * The work board's review queue (`shared/agent-control.ts`): the sessions an agent opened for a parent session, with
 * their diff stat, waiting for the person's Approve (merge the worktree branch) or Discard. Main pushes the whole
 * list for a parent on every change (`onAgentControlReview`); the board asks once when it mounts and acts through
 * the `agent_control_review` command, which main answers itself (the click is the confirmation).
 */
import { create } from "zustand";
import type {
	AgentReviewAction,
	AgentReviewEvent,
	AgentReviewItem,
	AgentReviewResult,
} from "../../shared/agent-control";
import { translate } from "../lib/i18n";
import { toast, toastError } from "./toast";

interface AgentReviewStore {
	/** Parent tab → the sessions it opened that still wait or run. */
	byTab: Readonly<Record<string, readonly AgentReviewItem[]>>;
	/** Children an Approve or Discard is working on. */
	busy: Readonly<Record<string, true>>;
	apply: (event: AgentReviewEvent) => void;
	refresh: (tabId: string) => Promise<void>;
	act: (tabId: string, action: Exclude<AgentReviewAction, "list">, child: string) => Promise<void>;
	reset: () => void;
}

const NONE: readonly AgentReviewItem[] = [];

export const useAgentReviewStore = create<AgentReviewStore>()((set, get) => ({
	byTab: {},
	busy: {},
	apply: event => set(state => ({ byTab: { ...state.byTab, [event.tabId]: event.items } })),
	refresh: async tabId => {
		const response = await window.omp?.rpc?.commandForTab?.(tabId, { type: "agent_control_review", action: "list" });
		if (response?.success) get().apply({ tabId, items: (response.data as { items: AgentReviewItem[] }).items });
	},
	act: async (tabId, action, child) => {
		set(state => ({ busy: { ...state.busy, [child]: true } }));
		try {
			const response = await window.omp.rpc.commandForTab(
				tabId,
				{ type: "agent_control_review", action, child },
				300_000,
			);
			if (!response.success) {
				toastError({ title: translate("workBoard.review.failed"), error: response });
				return;
			}
			const data = response.data as AgentReviewResult;
			const title = get().byTab[tabId]?.find(item => item.tabId === child)?.title ?? "";
			get().apply({ tabId, items: data.items });
			if (data.outcome === "merged")
				toast({ variant: "success", message: translate("workBoard.review.merged", { title }) });
			else if (data.outcome === "conflict")
				toast({
					variant: "warning",
					title: translate("workBoard.review.conflictTitle"),
					message: data.message ?? "",
				});
		} catch (error) {
			toastError({ title: translate("workBoard.review.failed"), error });
		} finally {
			set(state => {
				const { [child]: _done, ...busy } = state.busy;
				return { busy };
			});
		}
	},
	reset: () => set({ byTab: {}, busy: {} }),
}));

let subscribed = false;

/** Listen once for main's pushes (the board mounts it; a missing bridge, as in tests, is skipped). */
export function ensureAgentReviewSubscription(): void {
	if (subscribed || typeof window === "undefined" || typeof window.omp?.events?.onAgentControlReview !== "function")
		return;
	subscribed = true;
	window.omp.events.onAgentControlReview(event => useAgentReviewStore.getState().apply(event));
}

/** The review items of one parent tab. */
export function useAgentReviewItems(tabId: string | null): readonly AgentReviewItem[] {
	return useAgentReviewStore(state => (tabId ? (state.byTab[tabId] ?? NONE) : NONE));
}
