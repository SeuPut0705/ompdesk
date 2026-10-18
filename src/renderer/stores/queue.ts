/**
 * Queue store: the GUI's snapshot of the agent's pending steer/follow-up
 * queues. The `queue_update` session event is the authoritative update
 * channel — it fires on every queue mutation (enqueue, drain/consume,
 * remove, move, clear, dequeue restore) and lands here via setFromFrame from
 * the onBatch handler. get_queue survives only as the hydrate fallback
 * (mount, sidecar reconnect) since no snapshot predates the subscription.
 * Shared by the composer's queue tray (ComposerQueue) and the side panel's
 * queue tab (QueuePanel).
 */
import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import type { ImageContent, RpcGetQueueResult, RpcQueuedMessage } from "../../shared/rpc-types";
import { IMAGE_ONLY_CHIP, queueChipLabel } from "../lib/queue-chip";
import { activeTabCommand, createScopedStoreHook, type TabCommand } from "./session-runtime-context";

export type QueueLane = "steering" | "followUp";

/** Where an edited or lane-switched message landed: stock re-queues it, so it is the last of its lane now. */
export interface QueueMoved {
	id: string;
	lane: QueueLane;
	/** 1-based place in the lane, and the lane's length: "now 3 of 3". */
	position: number;
	count: number;
	/** What re-queued it: an edit, or a switch of lane. */
	kind: "edit" | "lane";
}

/** A sent message's pictures wait here for the chip that stock's queue will show for it (its id is assigned in main). */
interface PendingImages {
	text: string;
	images: ImageContent[];
	at: number;
}

/** A picture that never found its chip (the send failed, or the message started a turn instead) is forgotten after this. */
const PENDING_IMAGES_TTL_MS = 10_000;
/** How long `moved` stays set for the tray to point at the row. */
const MOVED_MS = 4_000;

export interface QueueStore {
	steering: RpcQueuedMessage[];
	followUp: RpcQueuedMessage[];
	/** The last edit or lane switch's landing place, for a few seconds; null otherwise. */
	moved: QueueMoved | null;
	/** Hydrate fallback pull via get_queue; only the latest response may apply. */
	refresh: () => Promise<void>;
	/** Apply an authoritative queue_update frame. */
	setFromFrame: (snapshot: RpcGetQueueResult) => void;
	/**
	 * A message with pictures was just sent into a running turn (a steer or follow-up): stock's queue lanes carry
	 * text only, so the renderer keeps the pictures and attaches them to the chip that shows up with that text
	 * (`images` on the item, which the tray counts). `text` is what stock will show: the message, or "[Image]".
	 */
	expectImages: (text: string, images: ImageContent[]) => void;
	/** The message lost its pictures (an edit or a lane move re-queues text only). */
	forgetImages: (id: string) => void;
	noteMoved: (moved: QueueMoved) => void;
}

export const createQueueStore = (command: TabCommand = activeTabCommand) => {
	/** Invalidates stale get_queue responses inside this tab runtime. */
	let refreshVersion = 0;
	let pending: PendingImages[] = [];
	/** Pictures by chip id, and the text each chip had in the last snapshot (an edit changes it and drops them). */
	const imagesById = new Map<string, ImageContent[]>();
	let textById = new Map<string, string>();
	let movedTimer: ReturnType<typeof setTimeout> | undefined;
	return createStore<QueueStore>()((set, get) => {
		/** Attach remembered pictures to the lanes' items and put the UI language's word on a picture-only chip. */
		const enrich = (snapshot: RpcGetQueueResult): Pick<QueueStore, "steering" | "followUp"> => {
			const now = Date.now();
			pending = pending.filter(entry => now - entry.at < PENDING_IMAGES_TTL_MS);
			const nextText = new Map<string, string>();
			const lanes = [snapshot.steering, snapshot.followUp].map(items =>
				items.map(item => {
					nextText.set(item.id, item.text);
					if (textById.has(item.id) && textById.get(item.id) !== item.text) imagesById.delete(item.id);
					let images = imagesById.get(item.id);
					if (!images && !textById.has(item.id)) {
						const index = pending.findIndex(entry => entry.text === item.text);
						if (index !== -1) {
							images = pending.splice(index, 1)[0].images;
							imagesById.set(item.id, images);
						}
					}
					const text = item.text === IMAGE_ONLY_CHIP ? queueChipLabel(item.text, images?.length ?? 0) : item.text;
					return text === item.text && !images ? item : { ...item, text, ...(images ? { images } : {}) };
				}),
			);
			textById = nextText;
			for (const id of imagesById.keys()) if (!nextText.has(id)) imagesById.delete(id);
			return { steering: lanes[0], followUp: lanes[1] };
		};
		return {
			steering: [],
			followUp: [],
			moved: null,
			refresh: async () => {
				const version = ++refreshVersion;
				try {
					const response = await command({ type: "get_queue" });
					if (version !== refreshVersion || !response.success) return;
					set(enrich(response.data as RpcGetQueueResult));
				} catch {
					// Sidecar mid-restart or a stale session: keep the last snapshot;
					// the next hydrate/queue_update refetches.
				}
			},
			setFromFrame: snapshot => {
				refreshVersion += 1;
				set(enrich(snapshot));
			},
			expectImages: (text, images) => {
				if (images.length > 0) pending.push({ text, images, at: Date.now() });
			},
			forgetImages: id => {
				imagesById.delete(id);
				// Untouched lanes keep their identity: an optimistic write in flight rolls back by it.
				set(state => {
					const holds = (items: RpcQueuedMessage[]) => items.some(item => item.id === id && item.images);
					if (!holds(state.steering) && !holds(state.followUp)) return state;
					const strip = (items: RpcQueuedMessage[]) =>
						items.map(item => (item.id === id && item.images ? { ...item, images: undefined } : item));
					return { steering: strip(state.steering), followUp: strip(state.followUp) };
				});
			},
			noteMoved: moved => {
				clearTimeout(movedTimer);
				set({ moved });
				movedTimer = setTimeout(() => {
					if (get().moved === moved) set({ moved: null });
				}, MOVED_MS);
			},
		};
	});
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
