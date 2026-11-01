import type { FocusEvent } from "react";

/**
 * Focus handlers for a scroll region that takes focus so the keyboard can scroll it (the transcript). A click
 * anywhere inside it focuses it too, without a ring; Chromium then draws the ring at the next key that stays there
 * (Backspace, an arrow: its `:focus-visible` heuristic turns on for the element already focused), a frame around the
 * whole pane nobody asked for. A region that gains focus without being `:focus-visible` (a pointer, a script) is
 * marked `data-pointer-focus` until it loses focus, and the stylesheet keeps its ring off; reached from the keyboard
 * (Tab, F6) it is `:focus-visible` as it gains focus and keeps its ring.
 */
export const pointerFocusMark = {
	onFocus(event: FocusEvent<HTMLElement>): void {
		const region = event.currentTarget;
		if (event.target === region) region.toggleAttribute("data-pointer-focus", !region.matches(":focus-visible"));
	},
	onBlur(event: FocusEvent<HTMLElement>): void {
		if (event.target === event.currentTarget) event.currentTarget.removeAttribute("data-pointer-focus");
	},
};
