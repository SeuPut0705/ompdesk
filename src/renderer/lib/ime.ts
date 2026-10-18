/**
 * True when this key event belongs to an in-progress IME composition, so the
 * keystroke belongs to the input method (committing "한글" with Enter, paging
 * candidates with the arrows) and not to the handler below it.
 *
 * React does not proxy `isComposing` onto its synthetic keyboard event, so the
 * composer and dialog handlers read it from `nativeEvent`; document-level
 * listeners get the native event itself. `keyCode === 229` is the legacy
 * `Process` signal some platforms fire instead.
 *
 * Escape keeps its meaning on the legacy path only: there every key reports 229,
 * so the code cannot identify Escape, and swallowing Escape would trap the user
 * in the overlay. While composition is live the IME itself owns Escape and
 * cancels its candidate window, so the dialog stays open — the rule every
 * editor overlay follows.
 *
 * Safari orders the commit the other way round: `compositionend` fires BEFORE the
 * Enter keydown that committed (which then reports `isComposing: false`, keyCode 13).
 * That Enter is the IME's too: an Enter this soon after a composition ended is
 * ignored ({@link POST_COMPOSITION_MS}; no person presses a second Enter that fast).
 */

/** An Enter keydown this long (ms) after a `compositionend` is the keystroke that committed it, not a new Enter. */
export const POST_COMPOSITION_MS = 40;

/** `timeStamp` of the last `compositionend` on the page; events of one page share the clock. */
let compositionEndedAt = Number.NEGATIVE_INFINITY;

/** Record a `compositionend` (the page-level listener below; a test calls it with an event). */
export function noteCompositionEnd(event: { timeStamp: number }): void {
	compositionEndedAt = event.timeStamp;
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
	// Capture: the composer, a dialog and an overlay all read the same clock whatever stops propagation.
	document.addEventListener("compositionend", noteCompositionEnd, true);
}

export function isImeKeyEvent(event: {
	key: string;
	keyCode?: number;
	isComposing?: boolean;
	timeStamp?: number;
	nativeEvent?: { isComposing?: boolean; timeStamp?: number };
}): boolean {
	const composing = event.nativeEvent?.isComposing ?? event.isComposing ?? false;
	if (composing || (event.keyCode === 229 && event.key !== "Escape")) return true;
	if (event.key !== "Enter") return false;
	const at = event.nativeEvent?.timeStamp ?? event.timeStamp;
	return at !== undefined && at >= compositionEndedAt && at - compositionEndedAt < POST_COMPOSITION_MS;
}
