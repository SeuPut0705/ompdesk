/**
 * The sessions an agent opened for a parent session (`shared/agent-control.ts`), with their status, step, clock and
 * report: the board's "Opened sessions" rows and the sidebar family read them. Main pushes the whole list for a
 * parent on every change (`onAgentControlReview`); the board asks once when it mounts through the
 * `agent_control_review` command. Nothing acts on them here: the opener's agent lands or discards its children.
 * With the list comes what every session it opened runs on and has cost (`usage`), the landed ones included.
 */
import { create } from "zustand";
import type { AgentChildUsage, AgentReviewEvent, AgentReviewItem, AgentReviewResult } from "../../shared/agent-control";

interface AgentReviewStore {
	/** Parent tab → the sessions it opened that still wait or run. */
	byTab: Readonly<Record<string, readonly AgentReviewItem[]>>;
	/** Child tab → what it runs on and has cost (from whichever parent's push named it last). */
	usage: Readonly<Record<string, AgentChildUsage>>;
	apply: (event: AgentReviewEvent) => void;
	refresh: (tabId: string) => Promise<void>;
	reset: () => void;
}

const NONE: readonly AgentReviewItem[] = [];

export const useAgentReviewStore = create<AgentReviewStore>()((set, get) => ({
	byTab: {},
	usage: {},
	apply: event =>
		set(state => ({
			byTab: { ...state.byTab, [event.tabId]: event.items },
			usage: event.usage?.length
				? { ...state.usage, ...Object.fromEntries(event.usage.map(row => [row.tabId, row])) }
				: state.usage,
		})),
	refresh: async tabId => {
		// A read that fails (a paired host's link down, a tab starting) keeps what is known; main's next push replaces it.
		const response = await window.omp?.rpc
			?.commandForTab?.(tabId, { type: "agent_control_review" })
			.catch(() => undefined);
		if (response?.success) get().apply({ tabId, ...(response.data as AgentReviewResult) });
	},
	reset: () => set({ byTab: {}, usage: {} }),
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
