import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useRef } from "react";

/** A drag this far (px) or a flick this fast (px/ms) dismisses the sheet. */
export const SHEET_DISMISS_DISTANCE = 96;
export const SHEET_DISMISS_VELOCITY = 0.6;

export type SheetDragEdge = "bottom" | "left";

/**
 * Drag-to-dismiss for a sheet's handle: the panel follows the finger toward its edge (down for a bottom or
 * full sheet, left for a left drawer), then closes past a distance or a flick, or springs back. Moves are
 * written straight to the panel's `translate` (no render per frame): its enter and exit animations own `transform`
 * and fill it, so a dismiss starts its exit from where the finger let go, and a refused one springs back.
 */
export function useSheetDrag(
	panelRef: RefObject<HTMLElement | null>,
	onClose: () => void,
	edge: SheetDragEdge = "bottom",
) {
	const drag = useRef<{ id: number; start: number; last: number; at: number; velocity: number } | null>(null);

	const offset = (event: { clientX: number; clientY: number }, start: number) =>
		Math.max(0, edge === "bottom" ? event.clientY - start : start - event.clientX);

	const place = (distance: number) => {
		const panel = panelRef.current;
		if (!panel) return;
		panel.style.translate = distance === 0 ? "" : edge === "bottom" ? `0 ${distance}px` : `${-distance}px 0`;
	};

	const onPointerDown = useCallback(
		(event: ReactPointerEvent<HTMLElement>) => {
			if (event.button !== 0 && event.pointerType === "mouse") return;
			const start = edge === "bottom" ? event.clientY : event.clientX;
			drag.current = { id: event.pointerId, start, last: 0, at: event.timeStamp, velocity: 0 };
			event.currentTarget.setPointerCapture(event.pointerId);
			const panel = panelRef.current;
			if (panel) panel.style.transition = "none";
		},
		[edge, panelRef],
	);

	const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		const distance = offset(event, current.start);
		const elapsed = event.timeStamp - current.at;
		if (elapsed > 0) current.velocity = (distance - current.last) / elapsed;
		current.last = distance;
		current.at = event.timeStamp;
		place(distance);
	};

	const finish = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
		const current = drag.current;
		if (!current || current.id !== event.pointerId) return;
		drag.current = null;
		const panel = panelRef.current;
		const springBack = () => {
			if (!panel) return;
			panel.style.transition = "translate var(--sc-duration-med) var(--sc-ease-spring)";
			place(0);
		};
		const dismiss =
			!cancelled && (current.last >= SHEET_DISMISS_DISTANCE || current.velocity >= SHEET_DISMISS_VELOCITY);
		if (!dismiss) return springBack();
		// The panel stays where it was dropped and its exit slides on from there. A close that is refused (an unsaved-changes
		// prompt) leaves it open: it springs back once the commit shows it did not start leaving.
		onClose();
		requestAnimationFrame(() => {
			if (panel?.isConnected && !panel.closest("[inert]")) springBack();
		});
	};

	return {
		onPointerDown,
		onPointerMove,
		onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event, false),
		onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
	};
}
