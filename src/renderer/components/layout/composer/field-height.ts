/**
 * Grow the field to fit its text, up to ~40% of the pane (one line while empty); the expanded composer
 * fills the pane instead, its height is CSS's.
 */
export function fitFieldHeight(el: HTMLTextAreaElement, expanded: boolean): void {
	if (expanded) {
		el.style.height = "";
		return;
	}
	el.style.height = "0px";
	const paneHeight = el.closest<HTMLElement>(".omp-session-pane")?.clientHeight ?? window.innerHeight;
	const maxHeight = el.value.length === 0 ? 24 : paneHeight * 0.4;
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
}
