/**
 * Composer content. Lives in a store (not InputArea-local state) so session
 * tabs can snapshot/restore text and image attachments together.
 *
 * Writes still flow through the same call sites as the old useState: every
 * producer (typing, paste markers, mentions, history recall, dequeue
 * restore, the `omp:fill-composer` window event) calls setDraft with a value
 * or an updater.
 *
 * Beside the content it holds what the composer's run controls need to agree on across the field, the Stop
 * button and the window-level Esc: a Stop already in flight, the first Esc of a stop-with-a-draft, the
 * automatic mode choice a prompt waits on, and the queued messages a Stop withdrew (`restoredQueue`).
 */
import { createStore } from "zustand/vanilla";
import type { ImageContent } from "../../shared/rpc-types";
import { createScopedStoreHook } from "./session-runtime-context";

export interface ComposerImage {
	content: ImageContent;
	preview: string;
}

/** How long the first Esc of a stop (or of a draft's clear) waits for its second. */
export const DOUBLE_ESC_MS = 1500;

/**
 * Text handed back to the composer (a failed send, a dequeued or withdrawn message) goes ahead of the
 * draft typed meanwhile, a blank line between: every restore joins the same way.
 */
export function prependToDraft(restored: string, draft: string): string {
	return draft.trim() ? `${restored}\n\n${draft}` : restored;
}

/**
 * One queued message a Stop withdrew (stock's `abort_and_restore_queue`), held apart from the draft until the
 * user decides: Resume sends it, Edit brings it into the field, Remove drops it. `text` is "" for a picture-only
 * message (stock's `[Image]` chip text is not content); show it with `restoredQueueLabel`.
 */
export interface RestoredQueueItem {
	id: string;
	lane: "steering" | "followUp";
	text: string;
	images: ComposerImage[];
}

type QueueLaneName = "steering" | "followUp";

/** The queued message the field is editing, and what Cancel puts back (RA-21). */
export interface EditingQueued {
	id: string;
	lane: QueueLaneName;
	/** The message's text when the edit began. */
	original: string;
	/** The draft and pictures the field held before the edit took it over. */
	snapshot: { draft: string; images: ComposerImage[] };
}

export interface ComposerStore {
	draft: string;
	sending: boolean;
	submissionUncertain: boolean;
	/**
	 * Withdraws the submission still being prepared (the automatic mode choice runs before a prompt
	 * leaves): true when it had not left yet, so nothing reaches omp. Null when none is pending.
	 */
	cancelSubmit: (() => boolean) | null;
	/** The automatic mode choice is being asked right now ("Deciding how to run this…"); Stop/Esc return at once. */
	decidingMode: boolean;
	/** A Stop was sent for the running turn and the turn has not ended yet: a second click or Esc sends nothing. */
	stopping: boolean;
	/** When the first Esc of "Esc again to stop" was pressed; null when none waits (an edit of the draft disarms it). */
	stopArmedAt: number | null;
	/**
	 * Queued messages the last Stop withdrew, oldest first (steers, then follow-ups). Filled only while a view that
	 * shows them is mounted (`restoredTrayMounted`); otherwise Stop merges them into the draft.
	 */
	restoredQueue: RestoredQueueItem[];
	/** A tray that renders `restoredQueue` is mounted (ComposerRestoredQueue): the only thing that makes Stop keep them apart. */
	restoredTrayMounted: number;
	/** A queued message is being edited in the field (Edit queued): its draft and pictures wait in the snapshot. */
	editingQueued: EditingQueued | null;
	setSending: (value: boolean) => void;
	setCancelSubmit: (cancel: (() => boolean) | null) => void;
	setSubmissionUncertain: (value: boolean) => void;
	setDecidingMode: (value: boolean) => void;
	setStopping: (value: boolean) => void;
	/** Arm "Esc again to stop"; disarms itself after `DOUBLE_ESC_MS`. */
	armStop: (now?: number) => void;
	disarmStop: () => void;
	/** Hold withdrawn queue entries apart from the draft. */
	holdRestored: (items: Omit<RestoredQueueItem, "id">[]) => void;
	dropRestored: (id: string) => void;
	clearRestored: () => void;
	/** Move held entries (all, or one) into the field: text ahead of the draft, blank-line separated; pictures join the strip. */
	restoreHeldToDraft: (id?: string) => void;
	/** A tray registers while mounted; the count keeps two panes of one store from unregistering each other. */
	setRestoredTrayMounted: (mounted: boolean) => void;
	/** The field takes over a queued message (snapshotting the draft and pictures it held). */
	beginEditQueued: (target: { id: string; lane: QueueLaneName; text: string }) => void;
	/** Leave the edit: the snapshot returns exactly; `prepend` (an edit whose message was already delivered) goes ahead of it. */
	endEditQueued: (prepend?: string) => void;
	images: ComposerImage[];
	/** Replace the draft, or compute the next value from the current one
	 * (React setState parity — InputArea's updater-form call sites unchanged). */
	setDraft: (next: string | ((current: string) => string)) => void;
	setImages: (next: ComposerImage[] | ((current: ComposerImage[]) => ComposerImage[])) => void;
	reset: () => void;
}

let nextRestoredId = 0;

export const createComposerStore = () =>
	createStore<ComposerStore>()((set, get) => ({
		draft: "",
		sending: false,
		submissionUncertain: false,
		cancelSubmit: null,
		decidingMode: false,
		stopping: false,
		stopArmedAt: null,
		restoredQueue: [],
		restoredTrayMounted: 0,
		editingQueued: null,
		setSending: sending => set({ sending }),
		setCancelSubmit: cancelSubmit => set({ cancelSubmit }),
		setSubmissionUncertain: submissionUncertain => set({ submissionUncertain }),
		setDecidingMode: decidingMode => set({ decidingMode }),
		setStopping: stopping => set({ stopping }),
		armStop: (now = Date.now()) => {
			set({ stopArmedAt: now });
			setTimeout(() => {
				if (get().stopArmedAt === now) set({ stopArmedAt: null });
			}, DOUBLE_ESC_MS);
		},
		disarmStop: () => {
			if (get().stopArmedAt !== null) set({ stopArmedAt: null });
		},
		holdRestored: items =>
			set(state => ({
				restoredQueue: [...state.restoredQueue, ...items.map(item => ({ ...item, id: `r${++nextRestoredId}` }))],
			})),
		dropRestored: id => set(state => ({ restoredQueue: state.restoredQueue.filter(item => item.id !== id) })),
		clearRestored: () => set({ restoredQueue: [] }),
		restoreHeldToDraft: id =>
			set(state => {
				const taken = state.restoredQueue.filter(item => id === undefined || item.id === id);
				if (taken.length === 0) return state;
				const text = taken
					.map(item => item.text)
					.filter(part => part.trim())
					.join("\n\n");
				return {
					restoredQueue: state.restoredQueue.filter(item => !taken.includes(item)),
					draft: text ? prependToDraft(text, state.draft) : state.draft,
					images: [...state.images, ...taken.flatMap(item => item.images)],
					stopArmedAt: null,
				};
			}),
		setRestoredTrayMounted: mounted =>
			set(state => ({ restoredTrayMounted: Math.max(0, state.restoredTrayMounted + (mounted ? 1 : -1)) })),
		beginEditQueued: ({ id, lane, text }) =>
			set(state => ({
				// A second Edit while one runs keeps the first snapshot: Cancel still returns to what the user typed.
				editingQueued: {
					id,
					lane,
					original: text,
					snapshot: state.editingQueued?.snapshot ?? { draft: state.draft, images: state.images },
				},
				draft: text,
				images: [],
				stopArmedAt: null,
			})),
		endEditQueued: prepend =>
			set(state => {
				const editing = state.editingQueued;
				if (!editing) return state;
				return {
					editingQueued: null,
					draft: prepend ? prependToDraft(prepend, editing.snapshot.draft) : editing.snapshot.draft,
					images: editing.snapshot.images,
					stopArmedAt: null,
				};
			}),
		images: [],
		setDraft: next =>
			set(state => {
				const draft = typeof next === "function" ? next(state.draft) : next;
				return draft === state.draft ? state : { draft, stopArmedAt: null };
			}),
		setImages: next => set(state => ({ images: typeof next === "function" ? next(state.images) : next })),
		reset: () =>
			set({
				draft: "",
				images: [],
				sending: false,
				submissionUncertain: false,
				cancelSubmit: null,
				decidingMode: false,
				stopping: false,
				stopArmedAt: null,
				restoredQueue: [],
				editingQueued: null,
			}),
	}));

const defaultComposerStore = createComposerStore();
export const useComposerStore = createScopedStoreHook("composer", defaultComposerStore);
