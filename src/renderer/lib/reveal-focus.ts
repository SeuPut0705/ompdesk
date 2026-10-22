/**
 * A "show N more" control that disappears once the rest of its list shows takes the keyboard focus with it, and
 * the browser drops focus on the page: the next Tab starts over from the top. `revealAndFocus` runs the state
 * update that shows the rest and puts focus on the first row it revealed, the one now where the control was.
 */
import { flushSync } from "react-dom";

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * `control` sits alone in its own list item (its parent is an `li`), or is itself an item of the list it extends
 * (never an `li` further up: a card in a list item is not the list its control extends). That item's place in
 * the list is where the first revealed row lands; its first focusable element takes focus, or the row itself. A
 * list whose revealed rows land elsewhere (spread over groups) names the row with `firstRevealed`, read after the
 * reveal.
 */
export function revealAndFocus(
	control: HTMLElement,
	reveal: () => void,
	firstRevealed?: () => Element | null | undefined,
): void {
	const item = control.parentElement?.tagName === "LI" ? control.parentElement : control;
	const list = item.parentElement;
	const index = list ? Array.prototype.indexOf.call(list.children, item) : -1;
	flushSync(reveal);
	const row = firstRevealed ? firstRevealed() : list?.children[index];
	if (!(row instanceof HTMLElement) || !row.isConnected) return;
	const target = row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE);
	if (target) {
		target.focus();
		return;
	}
	row.tabIndex = -1;
	row.focus();
}
