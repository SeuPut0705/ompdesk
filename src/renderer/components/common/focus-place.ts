/**
 * Where a control sat, so focus can go back near it once it is gone: a dialog or menu returns focus to its opener
 * when it closes, and an action that removed the opener (a confirmed delete taking its row) left nothing to return to.
 */
import { isTabbable } from "./popover-focus";

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Each ancestor of an element, nearest first, with the index of the child on the way to it. */
export type Place = Array<{ parent: Element; index: number }>;

export function placeOf(element: Element): Place {
	const place: Place = [];
	for (let node = element; node.parentElement; node = node.parentElement) {
		place.push({
			parent: node.parentElement,
			index: Array.prototype.indexOf.call(node.parentElement.children, node),
		});
	}
	return place;
}

/**
 * Focus the control nearest to where a removed opener sat: in its nearest ancestor still on the page, the first
 * focusable from the opener's old position on (what took its place), else the last one before it. Without this the
 * focus of a dialog whose action removed its opener fell to the page, and the next Tab started over from the top.
 */
export function focusNear(place: Place, panel: HTMLElement | null): void {
	for (const { parent, index } of place) {
		if (!parent.isConnected) continue;
		const children = Array.from(parent.children);
		for (const child of [...children.slice(index), ...children.slice(0, index).reverse()]) {
			const candidates = [child, ...child.querySelectorAll(FOCUSABLE)].filter(
				(element): element is HTMLElement =>
					element instanceof HTMLElement &&
					element.matches(FOCUSABLE) &&
					isTabbable(element) &&
					!panel?.contains(element),
			);
			if (children.indexOf(child) < index) candidates.reverse();
			// A control the browser will not focus (hidden by CSS) leaves focus where it was: try the next one.
			for (const target of candidates) {
				target.focus();
				if (document.activeElement === target) return;
			}
		}
	}
}
