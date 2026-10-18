/**
 * Grow the field to fit its text, up to ~40% of the pane (one line while empty); the expanded composer
 * fills the pane instead, its height is CSS's.
 *
 * The field is measured at 0px, and the reads below lay the page out that way. The field's box holds its
 * height for that layout: a collapsed composer handed its height to the transcript above for the read,
 * Chromium clamped the transcript's scroll offset to that larger viewport, and the restored height never
 * gave it back (no size changed, so no resize observer saw it). A transcript riding its live edge ended
 * up one line under the composer per keystroke's fit.
 */
export function fitFieldHeight(el: HTMLTextAreaElement, expanded: boolean): void {
	if (expanded) {
		el.style.height = "";
		return;
	}
	const box = el.parentElement;
	const heldMinHeight = box?.style.minHeight ?? "";
	if (box) box.style.minHeight = `${box.getBoundingClientRect().height}px`;
	el.style.height = "0px";
	const paneHeight = el.closest<HTMLElement>(".omp-session-pane")?.clientHeight ?? window.innerHeight;
	const maxHeight = el.value.length === 0 ? 24 : paneHeight * 0.4;
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	if (box) box.style.minHeight = heldMinHeight;
}
