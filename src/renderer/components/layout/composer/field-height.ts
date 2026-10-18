/** The browser sizes a textarea to its text itself (`field-sizing: content`, Chromium 123+): no measuring pass per key. */
export const FIELD_SIZING_SUPPORTED =
	typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");

/** Share of the session pane the field may grow to before it scrolls inside. */
const MAX_PANE_SHARE = 0.4;

/**
 * Where `field-sizing: content` is supported the field's height is CSS's (`.omp-composer-input[data-sizing]`), and
 * only its ceiling follows the pane: `--omp-field-max` is set from the pane's own resize, never read per keystroke
 * (the 0px measure of {@link fitFieldHeight} forced a layout of the whole draft on every key: 16 ms at 30k
 * characters). Returns the observer's cleanup; a browser without the property keeps {@link fitFieldHeight}.
 */
export function observeFieldCeiling(el: HTMLTextAreaElement): () => void {
	const pane = el.closest<HTMLElement>(".omp-session-pane");
	if (!pane || typeof ResizeObserver === "undefined") return () => {};
	const apply = () => el.style.setProperty("--omp-field-max", `${Math.round(pane.clientHeight * MAX_PANE_SHARE)}px`);
	apply();
	const observer = new ResizeObserver(apply);
	observer.observe(pane);
	return () => {
		observer.disconnect();
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
	const maxHeight = el.value.length === 0 ? 24 : paneHeight * 0.4;
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	if (box) box.style.minHeight = heldMinHeight;
}
