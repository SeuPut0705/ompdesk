/**
 * Prompt history in the composer (stores/input-history.ts): ↑/↓ recall, the ⌃R search's pick, and recording a
 * draft Esc clears. While entries show, the draft and its pictures wait in the history's stash.
 */
import { useEffect, useRef } from "react";
import { historyImages } from "../../../lib/history-images";
import { expandPasteMarkers } from "../../../lib/paste-blobs";
import type { TabRpc } from "../../../lib/tab-rpc";
import type { ComposerImage } from "../../../stores/composer";
import { type InputHistoryContext, useInputHistoryStore } from "../../../stores/input-history";

export interface ComposerHistory {
	/**
	 * ↑ (`older`) or ↓ at the field's caret: as in a terminal, ↑ recalls an older entry only with the caret at
	 * position 0, ↓ a newer one (and finally the stashed draft) only with the caret at the very end. True when an
	 * entry (or the draft) was placed.
	 */
	recallAdjacent: (older: boolean, field: HTMLTextAreaElement, text: string) => boolean;
	/** A ⌃R pick replaces the draft the way ↑ does. */
	pick: (prompt: string, text: string) => void;
	/** Keep a draft that is about to be cleared (its paste markers expanded). */
	record: (text: string) => void;
}

export function useComposerHistory({
	rpc,
	ready,
	cwd,
	owner,
	device,
	images,
	setImages,
	placeDraft,
}: {
	rpc: TabRpc;
	/** The tab's bridge is ready: the history is read from its machine then. */
	ready: boolean;
	cwd: string;
	/** `${tabId}:${sessionId}`: the composer the browsing belongs to. */
	owner: string;
	device: string | undefined;
	images: ComposerImage[];
	setImages: (next: ComposerImage[]) => void;
	placeDraft: (next: string, caret: number) => void;
}): ComposerHistory {
	/** The draft's pictures while ↑/↓ shows history entries (restored on the way back). */
	const navDraftImages = useRef<ComposerImage[]>([]);

	// Refresh from this tab's omp machine when its bridge is ready.
	useEffect(() => {
		if (ready) void useInputHistoryStore.getState().hydrate(rpc, device);
	}, [rpc, ready, device]);

	const context: InputHistoryContext = { cwd, owner, device };
	/** ↑/↓ (or a ⌃R pick) is showing history entries for this composer, the draft waiting in the stash. */
	const browsing = () => {
		const history = useInputHistoryStore.getState();
		return (
			history.navIndex !== -1 &&
			history.navContext?.owner === context.owner &&
			history.navContext?.cwd === context.cwd &&
			history.navContext?.device === context.device
		);
	};
	/**
	 * Show a history entry the history store moved to: the draft's own pictures step aside while
	 * browsing and come back with it, an entry brings the pictures it was sent with.
	 */
	const showRecalled = (recalled: string, wasBrowsing: boolean, caret: number) => {
		if (!wasBrowsing) navDraftImages.current = images;
		const backToDraft = useInputHistoryStore.getState().navIndex === -1;
		setImages(backToDraft ? navDraftImages.current : [...historyImages(recalled)]);
		placeDraft(recalled, caret);
	};

	return {
		recallAdjacent: (older, field, text) => {
			const caretStart = field.selectionStart ?? 0;
			const caretEnd = field.selectionEnd ?? caretStart;
			const history = useInputHistoryStore.getState();
			const wasBrowsing = browsing();
			const recalled =
				older && caretEnd === 0
					? history.prev(text, context)
					: !older && caretStart === text.length
						? history.next(context)
						: undefined;
			if (recalled === undefined) return false;
			showRecalled(recalled, wasBrowsing, older ? 0 : recalled.length);
			return true;
		},
		pick: (prompt, text) => {
			// The draft and its pictures wait in the history's stash (↓ brings them back), and Cmd/Ctrl+Z
			// restores the text.
			const wasBrowsing = browsing();
			if (useInputHistoryStore.getState().recall(prompt, text, context))
				showRecalled(prompt, wasBrowsing, prompt.length);
			else placeDraft(prompt, prompt.length);
		},
		record: text => useInputHistoryStore.getState().record(expandPasteMarkers(text), cwd, rpc, device),
	};
}
