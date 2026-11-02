import { type RefObject, useLayoutEffect, useRef } from "react";
import { useListMotion } from "../../../hooks/use-list-motion";

const KEYED = "[data-flip-key]";
/** Matches nothing: the commit that plays no motion at all. */
const NONE = "[data-flip-none]";

/**
 * Rows, project headers and family blocks of one sidebar list glide when the list changes (`useListMotion`, rows carry
 * `data-flip-key`; a row that arrives rises in).
 *
 * A project the person dragged to a new place is moved by dnd-kit's own transform, which compensates the new layout and
 * eases out: gliding it too would offset it twice. `dropped()` (the sort's `onDragEnd`) says the next change of the
 * projects' order is that move, so that one commit plays nothing and the list measures itself again from there.
 * While a filter is typed (`filtering`) the list holds still: it changes on every keystroke.
 */
export function useSidebarListMotion(
	listRef: RefObject<HTMLElement | null>,
	projectOrder: readonly string[],
	filtering: boolean,
) {
	const order = projectOrder.join("\n");
	const lastOrder = useRef(order);
	const sorted = useRef(false);
	useListMotion(listRef, {
		enter: true,
		selector: sorted.current && order !== lastOrder.current ? NONE : KEYED,
		still: filtering,
	});
	useLayoutEffect(() => {
		if (order === lastOrder.current) return;
		lastOrder.current = order;
		sorted.current = false;
	});
	return () => {
		sorted.current = true;
	};
}
