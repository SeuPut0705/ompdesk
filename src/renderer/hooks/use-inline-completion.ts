import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { InlineScheduler, inlineDraftEligibility } from "../../../resources/gui-bridge/modes/next-prompt-core";

export interface InlineCompletionOptions {
	/** Inline completion is effective for this tab AND the composer can take it (ready, idle). */
	enabled: boolean;
	/** The composer draft. */
	text: string;
	/** A slash / `@` completion menu or the large-paste choice is open. */
	menuOpen: boolean;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/** One request: the continuation of `draft`, or null when nothing fits. Aborted through `signal`. */
	complete(draft: string, requestId: string, signal: AbortSignal): Promise<string | null>;
}

export interface InlineCompletion {
	/** The muted continuation to render after the draft, only while it is valid for the current draft. */
	ghost: string | null;
	/** Requests started so far — the measurable cost (scheduler.started). */
	started(): number;
	/** Tab: the draft with the ghost appended (and the ghost consumed), or null when none shows. */
	accept(): string | null;
	/** Esc: hide the ghost for this draft; true when one was showing (the caller then claims the key). */
	dismiss(): boolean;
	/** Any other key: hide the ghost and abort the request in flight. */
	drop(): void;
	/** Re-read the caret (select / click / keyup). */
	syncCaret(): void;
	onFocus(): void;
	onBlur(): void;
	onCompositionStart(): void;
	onCompositionEnd(): void;
}

interface Ghost {
	draft: string;
	text: string;
}

/**
 * Ghost text after the caret: every change of the composer state goes through one
 * {@link InlineScheduler} (debounce, abort, single-line / caret-at-end / not-IME rules);
 * a result is shown only while it still matches the draft that asked for it.
 */
export function useInlineCompletion(options: InlineCompletionOptions): InlineCompletion {
	const { enabled, text, menuOpen, textareaRef } = options;
	const completeRef = useRef(options.complete);
	completeRef.current = options.complete;
	const requestCount = useRef(0);
	/** Draft the user dismissed with Esc: a late result for it is not shown again. */
	const dismissedDraft = useRef<string | null>(null);
	const [ghost, setGhost] = useState<Ghost | null>(null);
	const [focused, setFocused] = useState(false);
	const [composing, setComposing] = useState(false);
	const [caretAtEnd, setCaretAtEnd] = useState(true);

	const [scheduler] = useState(
		() =>
			new InlineScheduler({
				run: (draft, signal) => completeRef.current(draft, `inline-${++requestCount.current}`, signal),
				onResult: (draft, result) => {
					if (result && dismissedDraft.current !== draft) setGhost({ draft, text: result });
					else setGhost(null);
				},
			}),
	);

	const syncCaret = useCallback(() => {
		const el = textareaRef.current;
		if (!el) return;
		const end = el.value.length;
		const start = el.selectionStart ?? end;
		setCaretAtEnd(start === end && (el.selectionEnd ?? end) === end);
	}, [textareaRef]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a changed draft moves the caret
	useLayoutEffect(syncCaret, [text, syncCaret]);

	// Autofocused before this hook's handlers attached: pick the live state up once.
	useEffect(() => {
		const el = textareaRef.current;
		if (el && document.activeElement === el) setFocused(true);
	}, [textareaRef]);

	useEffect(() => {
		if (dismissedDraft.current !== text) dismissedDraft.current = null;
		setGhost(current => (current && current.draft !== text ? null : current));
		if (!enabled || !focused) {
			// A turn (not enabled) moves the conversation on: what was answered before no longer applies.
			if (enabled) scheduler.cancel();
			else scheduler.reset();
			return;
		}
		scheduler.input({ draft: text, caretAtEnd, composing, menuOpen });
	}, [enabled, focused, text, caretAtEnd, composing, menuOpen, scheduler]);
	useEffect(() => () => scheduler.cancel(), [scheduler]);

	const showing =
		ghost !== null &&
		enabled &&
		focused &&
		ghost.draft === text &&
		inlineDraftEligibility({ draft: text, caretAtEnd, composing, menuOpen }).ok;
	const visibleGhost = showing ? ghost.text : null;

	const drop = useCallback(() => {
		setGhost(null);
		scheduler.cancel();
	}, [scheduler]);

	return {
		ghost: visibleGhost,
		started: () => scheduler.started,
		accept: () => {
			if (visibleGhost === null) return null;
			drop();
			return `${text}${visibleGhost}`;
		},
		dismiss: () => {
			if (visibleGhost === null) return false;
			dismissedDraft.current = text;
			drop();
			return true;
		},
		drop,
		syncCaret,
		onFocus: () => setFocused(true),
		onBlur: () => {
			setFocused(false);
			drop();
		},
		onCompositionStart: () => {
			setComposing(true);
			drop();
		},
		onCompositionEnd: () => setComposing(false),
	};
}
