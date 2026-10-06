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

export interface ComposerStore {
	draft: string;
	sending: boolean;
	submissionUncertain: boolean;
	setSending: (value: boolean) => void;
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
		setSending: sending => set({ sending }),
		setSubmissionUncertain: submissionUncertain => set({ submissionUncertain }),
		images: [],
		setDraft: next => set(state => ({ draft: typeof next === "function" ? next(state.draft) : next })),
		setImages: next => set(state => ({ images: typeof next === "function" ? next(state.images) : next })),
		reset: () => set({ draft: "", images: [], sending: false, submissionUncertain: false }),
	}));

const defaultComposerStore = createComposerStore();
export const useComposerStore = createScopedStoreHook("composer", defaultComposerStore);
