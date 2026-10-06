/**
 * Queue store: the GUI's snapshot of the agent's pending steer/follow-up
 * queues. The `queue_update` session event is the authoritative update
 * channel — it fires on every queue mutation (enqueue, drain/consume,
 * remove, move, clear, dequeue restore) and lands here via setFromFrame from
 * the onBatch handler. get_queue survives only as the hydrate fallback
 * (mount, sidecar reconnect) since no snapshot predates the subscription.
 * Shared by the QueueDockChip manager modal and the pending bubbles at the
 * message-stream tail.
 */
import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import type { RpcGetQueueResult, RpcQueuedMessage } from "../../shared/rpc-types";
import { activeTabCommand, createScopedStoreHook, type TabCommand } from "./session-runtime-context";

export type QueueLane = "steering" | "followUp";

export interface QueueStore {
	steering: RpcQueuedMessage[];
	followUp: RpcQueuedMessage[];
	/** Hydrate fallback pull via get_queue; only the latest response may apply. */
	refresh: () => Promise<void>;
	/** Apply an authoritative queue_update frame. */
	setFromFrame: (snapshot: RpcGetQueueResult) => void;
}

export const createQueueStore = (command: TabCommand = activeTabCommand) => {
	/** Invalidates stale get_queue responses inside this tab runtime. */
	let refreshVersion = 0;
	return createStore<QueueStore>()(set => ({
		steering: [],
		followUp: [],
		refresh: async () => {
			const version = ++refreshVersion;
			try {
				const response = await command({ type: "get_queue" });
				if (version !== refreshVersion || !response.success) return;
				const data = response.data as RpcGetQueueResult;
				set({ steering: data.steering, followUp: data.followUp });
			} catch {
				// Sidecar mid-restart or a stale session: keep the last snapshot;
				// the next hydrate/queue_update refetches.
			}
		},
		setFromFrame: snapshot => {
			refreshVersion += 1;
			set({ steering: snapshot.steering, followUp: snapshot.followUp });
		},
	}));
};

const defaultQueueStore = createQueueStore();
export const useQueueStore = createScopedStoreHook("queue", defaultQueueStore);

/**
 * Queue data plus the hydrate-fallback wiring: pull get_queue on mount (the
 * frame stream only carries mutations after subscription). Steady-state
 * updates arrive as queue_update frames via use-rpc-events.
 */
export function useQueuedMessages(): { steering: RpcQueuedMessage[]; followUp: RpcQueuedMessage[] } {
	const steering = useQueueStore(s => s.steering);
	const followUp = useQueueStore(s => s.followUp);
	const refresh = useQueueStore(s => s.refresh);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	return { steering, followUp };
}
