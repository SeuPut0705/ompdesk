/**
 * Tab handling shared by the non-modal popovers anchored to a toolbar control (`Popover`, the composer's context
 * breakdown). A popover is portaled to the end of the body, so a native Tab from its last control would land on
 * whatever follows the body (the title bar), with the popover still open. Instead Tab on the last control closes the
 * popover and focus goes to the control after its anchor, Shift+Tab on the first goes back to the anchor.
 */

export const POPOVER_FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isTabbable = (element: HTMLElement): boolean =>
	element.closest("[inert], [hidden], [aria-hidden='true']") === null && element.getAttribute("tabindex") !== "-1";

/** The panel's tabbable controls in order. */
export function popoverTabStops(panel: HTMLElement): HTMLElement[] {
	return Array.from(panel.querySelectorAll<HTMLElement>(POPOVER_FOCUSABLE)).filter(isTabbable);
}

/** The first tabbable control after `anchor` in document order that is not inside `panel`. */
function tabStopAfter(anchor: HTMLElement, panel: HTMLElement): HTMLElement | null {
	const stops = Array.from(document.querySelectorAll<HTMLElement>(POPOVER_FOCUSABLE)).filter(
		element => isTabbable(element) && !panel.contains(element),
	);
	const index = stops.indexOf(anchor);
	if (index >= 0) return stops[index + 1] ?? null;
	// The anchor is not itself a tab stop (a wrapper): the first stop after it in the document.
	return stops.find(element => anchor.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null;
}

interface TabKeyLike {
	key: string;
	shiftKey: boolean;
	preventDefault: () => void;
}

/**
 * Handle a Tab press while focus is inside `panel`. Between the panel's own controls the browser moves focus
 * (returns false). On the edge it moves focus out itself and returns true: the caller closes the popover. A focus
 * left on the anchor is what `Popover`'s own cleanup does when nothing else took it.
 */
export function tabOutOfPopover(event: TabKeyLike, panel: HTMLElement, anchor: HTMLElement | null): boolean {
	if (event.key !== "Tab") return false;
	const active = document.activeElement as HTMLElement | null;
	if (!active || !panel.contains(active)) return false;
	const stops = popoverTabStops(panel);
	const edge = event.shiftKey
		? active === panel || active === stops[0]
		: active === panel || active === stops[stops.length - 1] || stops.length === 0;
	if (!edge) return false;
	event.preventDefault();
	if (!anchor) return true;
	(event.shiftKey ? anchor : (tabStopAfter(anchor, panel) ?? anchor)).focus();
	return true;
}
