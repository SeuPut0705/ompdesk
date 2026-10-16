/**
 * Composer content. Lives in a store (not InputArea-local state) so session
 * tabs can snapshot/restore text and image attachments together.
 *
 * Writes still flow through the same call sites as the old useState: every
 * producer (typing, paste markers, mentions, history recall, dequeue
 * restore, the `omp:fill-composer` window event) calls setDraft with a value
 * or an updater.
 */
import { createStore } from "zustand/vanilla";
import type { ImageContent } from "../../shared/rpc-types";
import { createScopedStoreHook } from "./session-runtime-context";

export interface ComposerImage {
	content: ImageContent;
	preview: string;
}

/**
 * Text handed back to the composer (a failed send, a dequeued or withdrawn message) goes ahead of the
 * draft typed meanwhile, a blank line between: every restore joins the same way.
 */
export function prependToDraft(restored: string, draft: string): string {
	return draft.trim() ? `${restored}\n\n${draft}` : restored;
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
	setSending: (value: boolean) => void;
	setCancelSubmit: (cancel: (() => boolean) | null) => void;
	setSubmissionUncertain: (value: boolean) => void;
	images: ComposerImage[];
	/** Replace the draft, or compute the next value from the current one
	 * (React setState parity — InputArea's updater-form call sites unchanged). */
	setDraft: (next: string | ((current: string) => string)) => void;
	setImages: (next: ComposerImage[] | ((current: ComposerImage[]) => ComposerImage[])) => void;
	reset: () => void;
}

export const createComposerStore = () =>
	createStore<ComposerStore>()(set => ({
		draft: "",
		sending: false,
		submissionUncertain: false,
		cancelSubmit: null,
		setSending: sending => set({ sending }),
		setCancelSubmit: cancelSubmit => set({ cancelSubmit }),
		setSubmissionUncertain: submissionUncertain => set({ submissionUncertain }),
		images: [],
		setDraft: next => set(state => ({ draft: typeof next === "function" ? next(state.draft) : next })),
		setImages: next => set(state => ({ images: typeof next === "function" ? next(state.images) : next })),
		reset: () => set({ draft: "", images: [], sending: false, submissionUncertain: false, cancelSubmit: null }),
	}));

const defaultComposerStore = createComposerStore();
export const useComposerStore = createScopedStoreHook("composer", defaultComposerStore);
