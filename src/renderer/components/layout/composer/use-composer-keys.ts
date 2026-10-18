/**
 * The composer field's keys, in priority order: IME composition, the pending paste choice, the inline ghost,
 * the suggestion chips and placeholder, the completion menu, the composer's chords (⌃R ⌃G ⌃J ⌃U), Esc (collapse
 * a selection, then the double Esc that clears the draft or runs stock's `doubleEscapeAction`), ↑/↓ history,
 * list continuation and Enter's send. Owns the "Esc again to clear" hint.
 */
import type { KeyboardEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { InlineCompletion } from "../../../hooks/use-inline-completion";
import { composerEnterNewline, noteHardwareKey } from "../../../lib/hardware-keyboard";
import { isImeKeyEvent } from "../../../lib/ime";
import { chordFromEvent, isComposerFollowUpKey, PLATFORM } from "../../../lib/keymap";
import { dropReferencedPastes, releasePaste, widenToPasteMarkers } from "../../../lib/paste-blobs";
import type { TabRpc } from "../../../lib/tab-rpc";
import type { ComposerImage } from "../../../stores/composer";
import { useUiStore } from "../../../stores/ui";
import { chipIndexForCode, type NextPromptChipsHandle } from "./NextPromptChips";
import { plannedDeletion } from "./paste-marker-edit";
import { lastAttachmentStop } from "./strip-roving";
import type { ComposerHistory } from "./use-composer-history";
import type { ComposerMenu } from "./use-composer-menu";
import type { ComposerPaste } from "./use-composer-paste";

/** Rows PageUp/PageDown move through the completion menu. */
const MENU_PAGE = 5;
/** Second Esc within this window clears the draft or runs the double-Esc action (stock uses 500 ms; a hint needs reading time). */
const DOUBLE_ESC_MS = 1500;
const MODIFIER_KEYS = ["Shift", "Control", "Alt", "Meta", "CapsLock"];

export interface ComposerKeys {
	onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
	/** The first Esc of a double Esc armed the clear: "Esc again to clear" shows. */
	escHint: boolean;
}

export function useComposerKeys({
	rpc,
	text,
	images,
	setImages,
	textareaRef,
	placeDraft,
	continueListAtCaret,
	paste,
	inline,
	chips,
	placeholderPrompt,
	acceptSuggestion,
	menu: menuHandle,
	history,
	expanded,
	toggleExpanded,
	collapse,
	toggleHistorySearch,
	runActive,
	touchInput,
	attachmentsRef,
	enterSends,
	send,
}: {
	rpc: TabRpc;
	text: string;
	images: readonly ComposerImage[];
	setImages: (next: ComposerImage[]) => void;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	placeDraft: (next: string, caret: number) => void;
	continueListAtCaret: () => boolean;
	paste: Pick<ComposerPaste, "pending" | "cancel" | "chooseInline">;
	inline: Pick<InlineCompletion, "accept" | "dismiss" | "drop">;
	/** The runner-up suggestion chips: shown, their texts, a pick, and the handle ↓ moves focus through. */
	chips: {
		shown: boolean;
		list: readonly string[];
		pick: (chip: string) => void;
		ref: RefObject<NextPromptChipsHandle | null>;
	};
	/** The suggestion shown as the placeholder (Tab / → take it), if any. */
	placeholderPrompt: string | undefined;
	acceptSuggestion: () => void;
	menu: Pick<ComposerMenu, "menu" | "setMenu" | "dismiss" | "insert">;
	history: ComposerHistory;
	expanded: boolean;
	toggleExpanded: (next?: boolean) => void;
	/** Collapse the expanded composer (after ⌘↵ sent its draft). */
	collapse: () => void;
	toggleHistorySearch: () => void;
	/** A run, a prompt not yet sent, or a manual compaction holds Esc: it is their stop/cancel, not the draft's. */
	runActive: boolean;
	/** Send the draft (`followUp`: the follow-up lane); true when it went out. */
	send: (overrideText?: string, forceMode?: "followUp") => boolean;
	/** A touch input (phone, tablet): without a physical keyboard plain Enter adds a line and only Send sends. */
	touchInput: boolean;
	/** The element holding the attachment strips: Backspace in an empty field focuses its last attachment. */
	attachmentsRef: RefObject<HTMLElement | null>;
	/** The "Enter sends on mobile" setting: a touch device's Enter sends like the desktop's. */
	enterSends: boolean;
}): ComposerKeys {
	const { menu, setMenu } = menuHandle;
	/** First Esc of a double-Esc, and whether its "Esc again" hint shows. */
	const escArmedAt = useRef<number | null>(null);
	const [escHint, setEscHint] = useState(false);

	// The "Esc again to clear" hint lasts as long as the second press counts; any edit disarms it.
	useEffect(() => {
		if (!escHint) return;
		const timer = setTimeout(() => setEscHint(false), DOUBLE_ESC_MS);
		return () => clearTimeout(timer);
	}, [escHint]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: an edit of the draft disarms a pending Esc
	useEffect(() => {
		escArmedAt.current = null;
		setEscHint(false);
	}, [text]);

	/** Stock `doubleEscapeAction` (default `rewind`): the rewind picker, the session tree, or nothing. */
	const runDoubleEscapeAction = async () => {
		const response = await rpc.getSettings(["doubleEscapeAction"]).catch(() => undefined);
		const values = response?.success
			? (response.data as { values?: Record<string, unknown> } | undefined)?.values
			: undefined;
		const action = values?.doubleEscapeAction ?? "rewind";
		if (action === "tree") useUiStore.getState().openSessionTree();
		else if (action === "rewind") useUiStore.getState().openBranchPicker();
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// IME composition (Chinese/Japanese/Korean input): while the candidate
		// window is open, Enter and friends belong to the IME — committing the
		// composition must never send the message.
		if (isImeKeyEvent(e)) return;
		// A key only a physical keyboard makes: a tablet with one attached sends on Enter like a desktop.
		noteHardwareKey(e);
		const enterNewline = composerEnterNewline(touchInput, enterSends);
		// Pending paste choice: Enter takes the first form (inline), Esc cancels it. Keys that would edit
		// the field under the menu wait: the paste has no place in the draft until it has its form.
		if (paste.pending) {
			if (e.key === "Escape") {
				e.preventDefault();
				paste.cancel();
			} else if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				paste.chooseInline();
			} else if (
				e.key === "Enter" ||
				e.key === "Backspace" ||
				e.key === "Delete" ||
				(e.key.length === 1 && !e.metaKey && !e.ctrlKey) ||
				((e.metaKey || e.ctrlKey) && (e.code === "KeyZ" || e.code === "KeyY" || e.code === "KeyX"))
			)
				e.preventDefault();
			return;
		}
		// A folded paste's marker is one unit: a delete that touches any part of it takes the whole marker, as one
		// edit (Cmd/Ctrl+Z puts it back with its paste), so no half marker is left to be sent as text (DI-3).
		if (e.key === "Backspace" || e.key === "Delete") {
			const el = textareaRef.current;
			const range = el && plannedDeletion(el.value, el.selectionStart, el.selectionEnd, e);
			const widened = el && range && widenToPasteMarkers(el.value, range.from, range.to);
			if (el && widened) {
				e.preventDefault();
				for (const id of widened.ids) releasePaste(id);
				placeDraft(`${el.value.slice(0, widened.from)}${el.value.slice(widened.to)}`, widened.from);
				return;
			}
			// Backspace in an empty field reaches for the last attachment (the strips are above the field): the
			// way to them from a physical keyboard, and Delete there removes it (DI-9). A soft keyboard's
			// Backspace on an empty field must keep the keyboard up.
			if (
				el &&
				!enterNewline &&
				e.key === "Backspace" &&
				el.value === "" &&
				!e.shiftKey &&
				!e.altKey &&
				!e.ctrlKey &&
				!e.metaKey
			) {
				const last = lastAttachmentStop(attachmentsRef.current);
				if (last) {
					e.preventDefault();
					last.focus();
					return;
				}
			}
		}
		// Ghost text: Tab takes it, Esc hides it (and only then keeps Esc's other meanings off);
		// any other key drops it and aborts the request (typing restarts the debounce).
		const plainKey = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
		if (e.key === "Tab" && plainKey) {
			const accepted = inline.accept();
			if (accepted !== null) {
				e.preventDefault();
				placeDraft(accepted, accepted.length);
				return;
			}
		}
		if (e.key === "Escape" && plainKey && inline.dismiss()) {
			e.preventDefault();
			return;
		}
		if (!MODIFIER_KEYS.includes(e.key)) inline.drop();
		if (chips.shown) {
			const chipIndex = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? chipIndexForCode(e.code) : undefined;
			const chip = chipIndex === undefined ? undefined : chips.list[chipIndex];
			if (chip !== undefined) {
				e.preventDefault();
				chips.pick(chip);
				return;
			}
			if (e.key === "ArrowDown" && plainKey) {
				e.preventDefault();
				chips.ref.current?.focusFirst();
				return;
			}
		}
		if (placeholderPrompt !== undefined && text === "" && (e.key === "Tab" || e.key === "ArrowRight") && plainKey) {
			e.preventDefault();
			placeDraft(placeholderPrompt, placeholderPrompt.length);
			acceptSuggestion();
			return;
		}
		if (menu && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			menuHandle.dismiss();
			return;
		}
		// The menu takes plain keys only: Shift+Enter still adds a line, ⌘↵ still sends, Shift+Tab
		// and Shift+arrows keep their own meaning.
		if (menu && plainKey) {
			const count = menu.items.length;
			// Home/End jump to the ends, PageUp/PageDown move a page; the caret stays put.
			const paged =
				e.key === "Home"
					? 0
					: e.key === "End"
						? count - 1
						: e.key === "PageUp"
							? Math.max(0, menu.index - MENU_PAGE)
							: e.key === "PageDown"
								? Math.min(count - 1, menu.index + MENU_PAGE)
								: undefined;
			if (paged !== undefined) {
				e.preventDefault();
				setMenu({ ...menu, index: Math.max(0, paged) });
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index + 1) % Math.max(1, count) });
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index - 1 + Math.max(1, count)) % Math.max(1, count) });
				return;
			}
			if (e.key === "Tab" || e.key === "Enter") {
				e.preventDefault();
				const item = menu.items[menu.index];
				if (item) menuHandle.insert(item);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				menuHandle.dismiss();
				return;
			}
		}
		// The composer's own chords are read from the physical key, as keymap.ts reads every chord:
		// `e.key` is "R" with Caps Lock on and another letter on a non-Latin layout.
		const chord = chordFromEvent(e);
		// Ctrl+R: history search overlay (TUI `app.history.search`).
		if (chord === "⌃R") {
			e.preventDefault();
			toggleHistorySearch();
			return;
		}
		// ⌃G: expand / collapse the composer in place.
		if (chord === "⌃G") {
			e.preventDefault();
			toggleExpanded();
			return;
		}
		if (expanded && e.key === "Escape") {
			// Claim the key: the app-wide Escape would abort a running turn.
			e.preventDefault();
			e.stopPropagation();
			toggleExpanded(false);
			return;
		}
		// ⌃J inserts a newline at the caret (macOS: on Windows Ctrl+J toggles the panel), continuing a list;
		// ⌃U deletes the selection, or back to the start of the line.
		const newline = chord === "⌃J" && PLATFORM === "mac";
		if (newline && continueListAtCaret()) {
			e.preventDefault();
			return;
		}
		if (newline || chord === "⌃U") {
			const el = textareaRef.current;
			if (!el) return;
			e.preventDefault();
			const start = el.selectionStart ?? text.length;
			const end = el.selectionEnd ?? start;
			const from = newline || start !== end ? start : start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
			const insert = newline ? "\n" : "";
			placeDraft(`${text.slice(0, from)}${insert}${text.slice(end)}`, from + insert.length);
			return;
		}
		// Esc: a selection collapses first. While no turn runs, a draft clears on a
		// second Esc (the first shows a hint; the cleared draft stays in ↑ history),
		// and an empty composer runs stock's `doubleEscapeAction` (rewind picker or
		// session tree, as in the TUI). A running turn keeps the app-wide stop.
		if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const el = textareaRef.current;
			if (el && el.selectionStart !== el.selectionEnd) {
				e.preventDefault();
				el.setSelectionRange(el.selectionEnd, el.selectionEnd);
				return;
			}
			if (!runActive) {
				e.preventDefault();
				const now = Date.now();
				const armed = escArmedAt.current !== null && now - escArmedAt.current < DOUBLE_ESC_MS;
				escArmedAt.current = armed ? null : now;
				if (text.trim() === "" && images.length === 0) {
					if (armed) void runDoubleEscapeAction();
					return;
				}
				if (!armed) {
					setEscHint(true);
					return;
				}
				history.record(text);
				dropReferencedPastes(text);
				// One native edit: Cmd/Ctrl+Z brings the cleared text back.
				placeDraft("", 0);
				setImages([]);
				setEscHint(false);
				return;
			}
		}
		// Up/Down prompt-history recall, as in a terminal: ↑ recalls an older entry only from an empty
		// composer or with the caret at position 0, ↓ a newer entry (and finally the stashed draft) only
		// with the caret at the very end. Anywhere else the arrows move the caret through the text.
		// Browsing stays a run of plain presses because a recall places the caret on the edge the key
		// came from — ↑ at position 0, ↓ at the end (stock pi-tui's directional anchor, #99) — so the
		// next press in the same direction satisfies the same rule; turning around takes one caret move.
		if (
			!expanded &&
			(e.key === "ArrowUp" || e.key === "ArrowDown") &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			!e.shiftKey
		) {
			const el = textareaRef.current;
			if (el && history.recallAdjacent(e.key === "ArrowUp", el, text)) {
				e.preventDefault();
				return;
			}
		}
		// Line-adding keys (Shift+Enter, plain Enter while expanded) continue a markdown list.
		if (
			e.key === "Enter" &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			(e.shiftKey || expanded || enterNewline) &&
			continueListAtCaret()
		) {
			e.preventDefault();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			// Soft keyboard: Enter is the return key. The chords (⌘↵, the follow-up chord) are a physical keyboard's and still send.
			if (enterNewline && !e.metaKey && !e.ctrlKey && !e.altKey) return;
			// The follow-up chord (⌃↵ on macOS, ⌥↵ on Windows) sends as a follow-up, queueing
			// behind the current yield (TUI app.message.followUp); idle sessions start
			// immediately either way. Every other Enter sends in the chip's mode, so the
			// platform's send chord (⌘↵, Ctrl+Enter on Windows) steers a running turn.
			const followUp = isComposerFollowUpKey(e);
			// Expanded: plain Enter is a newline; ⌘↵ sends and collapses.
			if (expanded && !e.metaKey && !e.ctrlKey && !followUp) return;
			e.preventDefault();
			// A held Enter sends once, never again on auto-repeat.
			if (e.repeat) return;
			// ⌘↵ collapses the expanded composer only once the draft went out.
			if (send(undefined, followUp ? "followUp" : undefined) && expanded) collapse();
		}
	};

	return { onKeyDown, escHint };
}
