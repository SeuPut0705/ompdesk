/**
 * The sessions an agent opened for a parent session (`shared/agent-control.ts`), with their status, step, clock and
 * report: the board's "Opened sessions" rows and the sidebar family read them. Main pushes the whole list for a
 * parent on every change (`onAgentControlReview`); the board asks once when it mounts through the
 * `agent_control_review` command. Nothing acts on them here: the opener's agent lands or discards its children.
 */
import { create } from "zustand";
import type { AgentReviewEvent, AgentReviewItem, AgentReviewResult } from "../../shared/agent-control";

interface AgentReviewStore {
	/** Parent tab → the sessions it opened that still wait or run. */
	byTab: Readonly<Record<string, readonly AgentReviewItem[]>>;
	apply: (event: AgentReviewEvent) => void;
	refresh: (tabId: string) => Promise<void>;
	reset: () => void;
}

const NONE: readonly AgentReviewItem[] = [];

export const useAgentReviewStore = create<AgentReviewStore>()((set, get) => ({
	byTab: {},
	apply: event => set(state => ({ byTab: { ...state.byTab, [event.tabId]: event.items } })),
	refresh: async tabId => {
		// A read that fails (a paired host's link down, a tab starting) keeps what is known; main's next push replaces it.
		const response = await window.omp?.rpc
			?.commandForTab?.(tabId, { type: "agent_control_review" })
			.catch(() => undefined);
		if (response?.success) get().apply({ tabId, items: (response.data as AgentReviewResult).items });
	},
	reset: () => set({ byTab: {} }),
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
