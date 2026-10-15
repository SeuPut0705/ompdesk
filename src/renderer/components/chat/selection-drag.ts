/**
 * Drag-selecting text in the virtualized transcript (A105). Two things break
 * native selection there: a press-and-drag past the viewport edge only scrolls
 * while the pointer is outside the scroller (never while it rests on the edge,
 * where the reader aims), and rows the virtualizer unmounts take the
 * selection's ends — and the text between them — out of the document.
 *
 * `installSelectionDrag` scrolls the transcript while a text drag holds the
 * pointer near or past its top or bottom edge, faster the further out it is,
 * and reports the drag so the transcript stops following streamed output for
 * it. `selectionRowSpan` names the rows a selection covers, so the
 * virtualizer keeps them mounted (ChatStream's range extractor) for as long
 * as the selection lasts.
 */

/** Band inside the scroller's top and bottom edge where a held drag starts scrolling. */
export const EDGE_BAND_PX = 32;
/** Fastest scroll per frame, reached this far past the band. */
const MAX_STEP_PX = 28;
const FULL_SPEED_DISTANCE_PX = 120;
/** Movement before a press counts as a drag (a click selects nothing to keep). */
const DRAG_THRESHOLD_PX = 4;
/** A selection spanning more rows than this keeps only its two ends mounted. */
export const MAX_PINNED_ROWS = 400;

/** Pixels to scroll this frame for a pointer at `y` over a scroller spanning `top`..`bottom` (negative = up). */
export function edgeScrollStep(y: number, top: number, bottom: number): number {
	const above = top + EDGE_BAND_PX - y;
	const below = y - (bottom - EDGE_BAND_PX);
	const depth = above > 0 ? above : below > 0 ? below : 0;
	if (depth === 0) return 0;
	const step = Math.max(
		1,
		Math.round((Math.min(depth, FULL_SPEED_DISTANCE_PX) / FULL_SPEED_DISTANCE_PX) * MAX_STEP_PX),
	);
	return above > 0 ? -step : step;
}

/** Presses on controls, editors and drag sources are theirs, not a text selection. */
const NOT_TEXT = "button, a, input, textarea, select, summary, [contenteditable], [draggable='true'], [role='button']";

export interface SelectionDragHandlers {
	/** A press inside the transcript turned into a drag. */
	onStart(): void;
	/** The drag ended (pointer up or cancelled). */
	onEnd(): void;
}

/** Wires drag autoscroll onto the transcript scroller; returns the cleanup. */
export function installSelectionDrag(scroller: HTMLElement, handlers: SelectionDragHandlers): () => void {
	const view = scroller.ownerDocument.defaultView;
	if (!view) return () => {};
	let press: { x: number; y: number; pointerId: number } | null = null;
	let dragging = false;
	let pointerY = 0;
	let frame = 0;

	const tick = () => {
		frame = 0;
		if (!dragging) return;
		const box = scroller.getBoundingClientRect();
		const step = edgeScrollStep(pointerY, box.top, box.bottom);
		if (step !== 0) scroller.scrollTop += step;
		frame = view.requestAnimationFrame(tick);
	};
	const stop = () => {
		if (frame) view.cancelAnimationFrame(frame);
		frame = 0;
		const wasDragging = dragging;
		press = null;
		dragging = false;
		view.removeEventListener("pointermove", onMove, true);
		view.removeEventListener("pointerup", onUp, true);
		view.removeEventListener("pointercancel", onUp, true);
		if (wasDragging) handlers.onEnd();
	};
	const onMove = (event: PointerEvent) => {
		if (!press || event.pointerId !== press.pointerId) return;
		pointerY = event.clientY;
		if (dragging) return;
		if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD_PX) return;
		dragging = true;
		handlers.onStart();
		frame = view.requestAnimationFrame(tick);
	};
	const onUp = (event: PointerEvent) => {
		if (press && event.pointerId === press.pointerId) stop();
	};
	const onDown = (event: PointerEvent) => {
		if (event.button !== 0 || event.pointerType === "touch" || !event.isPrimary) return;
		const target = event.target as Element | null;
		if (!target || target.closest?.(NOT_TEXT)) return;
		// The scrollbar strip (ChatStream's own pointer handler takes it).
		if (event.clientX >= scroller.getBoundingClientRect().right - 20) return;
		stop();
		press = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
		pointerY = event.clientY;
		// The window, not the scroller: the pointer leaves it while the drag goes on.
		view.addEventListener("pointermove", onMove, true);
		view.addEventListener("pointerup", onUp, true);
		view.addEventListener("pointercancel", onUp, true);
	};
	scroller.addEventListener("pointerdown", onDown);
	return () => {
		scroller.removeEventListener("pointerdown", onDown);
		stop();
	};
}

/** The `[data-row-key]` row of `node` inside `scroller`, or null. */
function rowKeyOf(node: Node | null, scroller: HTMLElement): string | null {
	const element = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
	const row = element?.closest<HTMLElement>("[data-row-key]");
	return row && scroller.contains(row) ? (row.dataset.rowKey ?? null) : null;
}

/**
 * Row keys the transcript's selection covers: every row from its first to its
 * last end (only the two ends past `MAX_PINNED_ROWS`); empty for a collapsed
 * selection or one outside the transcript. Null when the selection still
 * exists but neither end is in a mounted row: the caller keeps what it had.
 */
export function selectionRowSpan(
	selection: Selection | null,
	scroller: HTMLElement,
	rowKeys: readonly string[],
): string[] | null {
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
	const ends = [rowKeyOf(selection.anchorNode, scroller), rowKeyOf(selection.focusNode, scroller)].filter(
		(key): key is string => key !== null,
	);
	if (ends.length === 0) {
		const range = selection.getRangeAt(0);
		return scroller.contains(range.commonAncestorContainer) ? null : [];
	}
	const positions = ends.map(key => rowKeys.indexOf(key)).filter(index => index >= 0);
	if (positions.length < 2) return [...new Set(ends)];
	const first = Math.min(...positions);
	const last = Math.max(...positions);
	if (last - first + 1 > MAX_PINNED_ROWS) return [...new Set(ends)];
	return rowKeys.slice(first, last + 1);
}
