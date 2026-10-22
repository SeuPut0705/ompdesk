/**
 * Where a control sat, so focus can go back near it once it is gone: a dialog or menu returns focus to its opener
 * when it closes, and an action that removed the opener (a confirmed delete taking its row) left nothing to return to.
 */
import { isTabbable } from "./popover-focus";

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Each ancestor of an element, nearest first, with the index of the child on the way to it, and the session tab the
 * element belonged to (a session pane's `data-tab-id`).
 */
export interface Place {
	steps: Array<{ parent: Element; index: number }>;
	tab: string | null;
}

const NOWHERE: Place = { steps: [], tab: null };

export function placeOf(element: Element | null): Place {
	if (!element) return NOWHERE;
	const steps: Place["steps"] = [];
	for (let node = element; node.parentElement; node = node.parentElement) {
		steps.push({
			parent: node.parentElement,
			index: Array.prototype.indexOf.call(node.parentElement.children, node),
		});
	}
	return { steps, tab: tabOf(element) };
}

function tabOf(element: Element): string | null {
	return element.closest("[data-tab-id]")?.getAttribute("data-tab-id") ?? null;
}

/**
 * Focus the control nearest to where a removed opener sat: in its nearest ancestor still on the page, the first
 * focusable from the opener's old position on (what took its place), else the last one before it. Without this the
 * focus of a dialog whose action removed its opener fell to the page, and the next Tab started over from the top.
 */
export function focusNear(place: Place, panel: HTMLElement | null): void {
	// An opener whose session tab was switched away (⌃Tab's switcher closes over the new tab, whose composer took the
	// old one's place) has no place near it: the tab change hands focus to the new composer (lib/tab-focus.ts), and a
	// control picked here (the new transcript) would keep it from doing so.
	const tabs = Array.from(document.querySelectorAll("[data-tab-id]"), pane => pane.getAttribute("data-tab-id"));
	if (place.tab !== null && !tabs.includes(place.tab)) return;
	for (const { parent, index } of place.steps) {
		if (!parent.isConnected) continue;
		// The body holds portals (other dialogs, the toast stack): focus there is no place near the opener, and a
		// toast holding focus never expires. An opener whose whole layer went (a gallery dialog) has no place left.
		if (parent === document.body || parent === document.documentElement) return;
		const children = Array.from(parent.children);
		for (const child of [...children.slice(index), ...children.slice(0, index).reverse()]) {
			const candidates = [child, ...child.querySelectorAll(FOCUSABLE)].filter(
				(element): element is HTMLElement =>
					element instanceof HTMLElement &&
					element.matches(FOCUSABLE) &&
					isTabbable(element) &&
					tabOf(element) === place.tab &&
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
