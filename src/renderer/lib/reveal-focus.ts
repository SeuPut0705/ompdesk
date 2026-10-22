/**
 * A "show N more" control that disappears once the rest of its list shows takes the keyboard focus with it, and
 * the browser drops focus on the page: the next Tab starts over from the top. `revealAndFocus` runs the state
 * update that shows the rest and puts focus on the first row it revealed, the one now where the control was.
 */
import { flushSync } from "react-dom";

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * `control` sits in its own list item (`li`), or is itself an item of the list it extends. That item's place in
 * the list is where the first revealed row lands; its first focusable element takes focus, or the row itself.
 */
export function revealAndFocus(control: HTMLElement, reveal: () => void): void {
	const item = control.closest("li") ?? control;
	const list = item.parentElement;
	const index = list ? Array.prototype.indexOf.call(list.children, item) : -1;
	flushSync(reveal);
	const row = list?.children[index];
	if (!(row instanceof HTMLElement) || !row.isConnected) return;
	const target = row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE);
	if (target) {
		target.focus();
		return;
	}
	row.tabIndex = -1;
	row.focus();
}
