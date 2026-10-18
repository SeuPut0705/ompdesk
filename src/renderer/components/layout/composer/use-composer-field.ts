/**
 * The composer's text field: the one ref every part of the composer writes through, the composer's own edits
 * of it (one native edit each, so Cmd/Ctrl+Z undoes them), and its height and width.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { continueList } from "../../../lib/list-continue";
import { FIELD_SIZING_SUPPORTED, fitFieldHeight, observeFieldCeiling } from "./field-height";
import { editFieldText } from "./input-area-utils";

/** Below this field width the idle hint no longer fits on its line (ko, 14px: ~250px of text plus padding). */
const NARROW_FIELD_PX = 290;

export interface ComposerFieldHandle {
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/** True while the composer writes its own draft into the field: the field's onChange then only mirrors it. */
	ownEdit: RefObject<boolean>;
	/** Write the draft and its caret in one task (one native edit in the focused field). */
	placeDraft: (next: string, caret: number) => void;
	/** Continue (or end) a markdown list at the caret for a newline key; false when the plain newline should stand. */
	continueListAtCaret: () => boolean;
	/** Splice text in at the caret (replacing a selection), space-separated from its neighbours. */
	insertAtCaret: (insert: string) => void;
	/** The field is narrower than the idle hint (a pane of a 2x2 split). */
	fieldNarrow: boolean;
}

export function useComposerField({
	text,
	setText,
	expanded,
}: {
	text: string;
	setText: (next: string) => void;
	/** The expanded composer fills the pane: its height is CSS's. */
	expanded: boolean;
}): ComposerFieldHandle {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const ownEdit = useRef(false);
	/**
	 * Write the draft and its caret in one task. A caret placed on a later frame moved
	 * whatever the next keys did meanwhile (a select-all, typed text); written here,
	 * React finds its value already in the field and leaves the caret alone. In the
	 * focused field the write is one native edit (editFieldText), so Cmd/Ctrl+Z undoes it
	 * and brings back what was there; a value set by script corrupted the undo stack.
	 */
	const placeDraft = useCallback(
		(next: string, caret: number) => {
			const el = textareaRef.current;
			if (el) {
				ownEdit.current = true;
				try {
					if (!editFieldText(el, next)) el.value = next;
				} finally {
					ownEdit.current = false;
				}
				el.setSelectionRange(caret, caret);
			}
			setText(next);
		},
		[setText],
	);
	/**
	 * Continue (or end) a markdown list at the caret for a newline key. The edit goes through the
	 * browser's own insertion so Cmd/Ctrl+Z restores the plain newline; a field that refuses it
	 * (no `execCommand`) takes the draft directly. False when the plain newline should stand.
	 */
	const continueListAtCaret = (): boolean => {
		const el = textareaRef.current;
		if (!el) return false;
		const value = el.value;
		const start = el.selectionStart ?? value.length;
		const edit = continueList(value, start, el.selectionEnd ?? start);
		if (!edit) return false;
		const next = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
		el.setSelectionRange(edit.from, edit.to);
		// The newline and the bullet are separate insertions: one undo then leaves the plain newline.
		const exec = typeof document.execCommand === "function" ? document.execCommand.bind(document) : undefined;
		let done = false;
		if (exec !== undefined) {
			if (edit.insert === "") done = exec("delete");
			else if (edit.insert.length === 1) done = exec("insertText", false, edit.insert);
			else if (exec("insertText", false, "\n")) {
				// Moving the caret closes the open typing command, so the bullet is its own undo step.
				el.setSelectionRange(edit.from + 1, edit.from + 1);
				done = exec("insertText", false, edit.insert.slice(1));
			}
		}
		if (!done || el.value !== next) placeDraft(next, edit.caret);
		else el.setSelectionRange(edit.caret, edit.caret);
		return true;
	};
	const insertAtCaret = (insert: string) => {
		const el = textareaRef.current;
		const current = el?.value ?? text;
		const start = el?.selectionStart ?? current.length;
		const end = el?.selectionEnd ?? start;
		const before = current.slice(0, start);
		const after = current.slice(end);
		const inserted = `${before && !/\s$/.test(before) ? " " : ""}${insert}${/^\s/.test(after) ? "" : " "}`;
		el?.focus();
		placeDraft(`${before}${inserted}${after}`, start + inserted.length);
	};

	// A pane of a 2x2 split has a field narrower than the idle hint ("Ask anything · @ files · / commands"):
	// it shows the short prompt instead of a hint cut mid-glyph. A new width also rewraps the draft, and a new pane
	// or visible height (a phone rotated back, the keyboard gone) moves the ceiling it may grow to, so the field's
	// height is fitted again (a side panel opening made the draft scroll inside a too-short field).
	const [fieldNarrow, setFieldNarrow] = useState(false);
	useEffect(() => {
		const el = textareaRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const pane = el.closest<HTMLElement>(".omp-session-pane");
		let width = el.clientWidth;
		let paneHeight = pane?.clientHeight ?? 0;
		const observer = new ResizeObserver(() => {
			setFieldNarrow(el.clientWidth > 0 && el.clientWidth < NARROW_FIELD_PX);
			const nextPaneHeight = pane?.clientHeight ?? 0;
			if (el.clientWidth === width && nextPaneHeight === paneHeight) return;
			width = el.clientWidth;
			paneHeight = nextPaneHeight;
			fitFieldHeight(el, expanded);
		});
		observer.observe(el);
		if (pane) observer.observe(pane);
		const refit = () => fitFieldHeight(el, expanded);
		window.visualViewport?.addEventListener("resize", refit);
		return () => {
			observer.disconnect();
			window.visualViewport?.removeEventListener("resize", refit);
		};
	}, [expanded]);

	useEffect(() => {
		const el = textareaRef.current;
		if (el && FIELD_SIZING_SUPPORTED && !expanded) return observeFieldCeiling(el);
	}, [expanded]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the field's height follows its text (read from the element)
	useEffect(() => {
		const el = textareaRef.current;
		if (el) fitFieldHeight(el, expanded);
	}, [text, expanded]);

	return { textareaRef, ownEdit, placeDraft, continueListAtCaret, insertAtCaret, fieldNarrow };
}
