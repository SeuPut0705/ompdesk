/**
 * Live surfaces mark the region a reader must see with `data-live-focus`:
 * `start` (an edit's newest hunk, a read's first line) is shown from its top,
 * `end` (a streaming write) keeps its tail in view.
 */
const FOCUS_SELECTOR = "[data-live-focus]";
/** Scrollers a renderer nests inside its surface (code blocks, diff boxes). */
const INNER_SCROLLERS = "pre, .overflow-y-auto, .overflow-auto";
/** Context left above a `start` focus, capped at a quarter of the scroller. */
const FOCUS_MARGIN_PX = 32;

/** Keys that scroll the focused stage; pressing one hands scrolling to the reader. */
export const STAGE_SCROLL_KEYS: Record<string, true> = {
	ArrowUp: true,
	ArrowDown: true,
	PageUp: true,
	PageDown: true,
	Home: true,
	End: true,
	" ": true,
};

/** The newest focus mark under `root` — later files and entries are the newer change. */
export function liveFocusTarget(root: Element): HTMLElement | null {
	const marks = root.querySelectorAll<HTMLElement>(FOCUS_SELECTOR);
	return marks[marks.length - 1] ?? null;
}

/**
 * Scrolls every scroller from `target` up to and including `root` so the
 * focus is in view. Nothing above `root` moves: the transcript stays where
 * the reader left it. Each scroller's shift is applied to the target's
 * position before the next one is measured against it, so nested scrollers
 * agree even while a smooth scroll is still under way.
 */
export function revealLiveFocus(root: HTMLElement, target: HTMLElement, behavior: ScrollBehavior): void {
	const end = target.dataset.liveFocus === "end";
	if (end) {
		for (const inner of target.querySelectorAll<HTMLElement>(INNER_SCROLLERS)) {
			const max = inner.scrollHeight - inner.clientHeight;
			if (max > 1 && inner.scrollTop < max) inner.scrollTo({ top: max, behavior });
		}
	}
	const box = target.getBoundingClientRect();
	let top = box.top;
	let bottom = box.bottom;
	for (let element = target.parentElement; element; element = element.parentElement) {
		const max = element.scrollHeight - element.clientHeight;
		if (max > 1) {
			const view = element.getBoundingClientRect();
			const wanted = end
				? element.scrollTop + bottom - (view.top + element.clientHeight)
				: element.scrollTop + top - view.top - Math.min(FOCUS_MARGIN_PX, element.clientHeight / 4);
			const next = Math.round(Math.max(0, Math.min(max, wanted)));
			const shift = next - element.scrollTop;
			if (Math.abs(shift) >= 1) {
				element.scrollTo({ top: next, behavior });
				top -= shift;
				bottom -= shift;
			}
		}
		if (element === root) break;
	}
}
