/** The browser sizes a textarea to its text itself (`field-sizing: content`, Chromium 123+): no measuring pass per key. */
export const FIELD_SIZING_SUPPORTED =
	typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

/** Share of the session pane the field may grow to before it scrolls inside. */
const MAX_PANE_SHARE = 0.4;
/** Room the rest of the screen keeps while the field grows (header, one transcript line, the row of controls). */
const KEEP_VISIBLE_PX = 120;

/**
 * The tallest the field grows before it scrolls inside: 40 % of the pane, and never so tall that less than
 * {@link KEEP_VISIBLE_PX} of the visible screen stays for the rest (a phone with its keyboard up shows ~500 px).
 */
export function fieldCeiling(paneHeight: number, visibleHeight: number): number {
	return Math.max(0, Math.min(paneHeight * MAX_PANE_SHARE, visibleHeight - KEEP_VISIBLE_PX));
}

/** What the screen shows right now: the visual viewport (keyboard, zoom) where there is one. */
export function visibleScreenHeight(): number {
	if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
	return window.visualViewport?.height || window.innerHeight;
}

/**
 * Where `field-sizing: content` is supported the field's height is CSS's (`.omp-composer-input[data-sizing]`), and
 * only its ceiling follows the pane and the visible height: `--omp-field-max` is set from the pane's own resize and
 * the visual viewport's, never read per keystroke (the 0px measure of {@link fitFieldHeight} forced a layout of the
 * whole draft on every key: 16 ms at 30k characters). Returns the observer's cleanup; a browser without the property
 * keeps {@link fitFieldHeight}.
 */
export function observeFieldCeiling(el: HTMLTextAreaElement): () => void {
	const pane = el.closest<HTMLElement>(".omp-session-pane");
	if (!pane || typeof ResizeObserver === "undefined") return () => {};
	const apply = () =>
		el.style.setProperty(
			"--omp-field-max",
			`${Math.round(fieldCeiling(pane.clientHeight, visibleScreenHeight()))}px`,
		);
	apply();
	const observer = new ResizeObserver(apply);
	observer.observe(pane);
	window.visualViewport?.addEventListener("resize", apply);
	return () => {
		observer.disconnect();
		window.visualViewport?.removeEventListener("resize", apply);
		el.style.removeProperty("--omp-field-max");
	};
}

/**
 * Grow the field to fit its text, up to ~40% of the pane (one line while empty); the expanded composer
 * fills the pane instead, its height is CSS's (as is every height where `field-sizing` is supported).
 *
 * The field is measured at 0px, and the reads below lay the page out that way. The field's box holds its
 * height for that layout: a collapsed composer handed its height to the transcript above for the read,
 * Chromium clamped the transcript's scroll offset to that larger viewport, and the restored height never
 * gave it back (no size changed, so no resize observer saw it). A transcript riding its live edge ended
 * up one line under the composer per keystroke's fit.
 */
export function fitFieldHeight(el: HTMLTextAreaElement, expanded: boolean): void {
	if (expanded || FIELD_SIZING_SUPPORTED) {
		el.style.height = "";
		return;
	}
	const box = el.parentElement;
	const heldMinHeight = box?.style.minHeight ?? "";
	if (box) box.style.minHeight = `${box.getBoundingClientRect().height}px`;
	el.style.height = "0px";
	const paneHeight = el.closest<HTMLElement>(".omp-session-pane")?.clientHeight ?? window.innerHeight;
	const maxHeight = el.value.length === 0 ? 24 : fieldCeiling(paneHeight, visibleScreenHeight());
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	if (box) box.style.minHeight = heldMinHeight;
}
