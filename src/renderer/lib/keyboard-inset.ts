/**
 * On-screen keyboard tracking for the mobile shell. Chrome on Android resizes the layout viewport when the
 * keyboard opens (`interactive-widget=resizes-content`); iOS Safari only shrinks the visual viewport and
 * scrolls the page. `--kb-inset` is the part of the layout viewport the keyboard covers
 * (`innerHeight − visualViewport.height − offsetTop`), 0 where the layout already resized, so the composer's
 * `bottom: max(var(--safe-b), var(--kb-inset))` is right on both. `html[data-kb="open"]` marks a keyboard tall
 * enough not to be browser chrome (the safe-area inset is under it, so CSS drops it).
 *
 * Pinch zoom shrinks the visual viewport too (its height is the layout height over the scale) and pans it
 * (`offsetTop`) with no keyboard at all, so while zoomed only the screen height the keyboard takes counts:
 * `innerHeight − visualViewport.height × scale`. Read the plain way, a zoom looked like a keyboard taller
 * than the screen half, shrank the shell to the zoomed patch and scrolled the user's pan back to the top.
 */

const KEYBOARD_MIN_PX = 80;
/** Above this scale the page is pinch-zoomed (1 within rounding otherwise). */
const ZOOMED_SCALE = 1.01;

export function keyboardInset(
	viewport: Pick<VisualViewport, "height" | "offsetTop" | "scale">,
	innerHeight: number,
): number {
	const covered =
		viewport.scale > ZOOMED_SCALE
			? innerHeight - viewport.height * viewport.scale
			: innerHeight - viewport.height - viewport.offsetTop;
	return Math.max(0, Math.round(covered));
}

/**
 * Android Chrome with `interactive-widget=resizes-content` shrinks the layout viewport itself, so the visual
 * viewport matches it and `keyboardInset` reads 0: the keyboard is the height the layout lost since it was at
 * rest (`baselineHeight`, the tallest layout seen at this width) while a text field has focus. The focus test
 * keeps split-screen or a window resize from counting as a keyboard; a dynamic toolbar is under the minimum.
 */
export function layoutKeyboardOpen(baselineHeight: number, innerHeight: number, editableFocused: boolean): boolean {
	return editableFocused && baselineHeight - innerHeight >= KEYBOARD_MIN_PX;
}

export function startKeyboardInset(root: HTMLElement = document.documentElement): () => void {
	const viewport = window.visualViewport;
	if (!viewport) return () => {};
	// Set by the first update (a width of 0 is never a layout's).
	let baselineWidth = 0;
	let baselineHeight = 0;
	let shownInset: number | null = null;
	const update = () => {
		// A new width (rotation) is a new layout: forget the old tallest height.
		if (window.innerWidth !== baselineWidth) {
			baselineWidth = window.innerWidth;
			baselineHeight = window.innerHeight;
		}
		const active = document.activeElement;
		const focused =
			active instanceof HTMLElement && active.matches("input, textarea, select, [contenteditable='true']");
		const resized = layoutKeyboardOpen(baselineHeight, window.innerHeight, focused);
		if (!resized) baselineHeight = Math.max(baselineHeight, window.innerHeight);
		const inset = keyboardInset(viewport, window.innerHeight);
		// A custom property on the root restyles the whole page: written only when it changes (every visual
		// viewport scroll calls this).
		if (inset !== shownInset) {
			root.style.setProperty("--kb-inset", `${inset}px`);
			shownInset = inset;
		}
		// The keyboard hides the home indicator / gesture bar either way: CSS drops the bottom inset.
		const open = inset >= KEYBOARD_MIN_PX || resized;
		if (open && root.dataset.kb !== "open") root.dataset.kb = "open";
		else if (!open && root.dataset.kb !== undefined) delete root.dataset.kb;
		// iOS scrolls the (fixed) page to reveal the focused field; the shell never scrolls. A zoomed page's
		// pan is the user's own.
		if (inset >= KEYBOARD_MIN_PX && viewport.scale <= ZOOMED_SCALE && (window.scrollY !== 0 || window.scrollX !== 0))
			window.scrollTo(0, 0);
	};
	// Focus moves after its event, so a blur or focus reads `activeElement` one task later.
	const afterFocus = () => setTimeout(update, 0);
	// The first read waits for the next frame: this starts while the shell's attributes were just set, and the
	// visual viewport's size read here would lay the whole page out inside that task (and again in the frame).
	const firstFrame = typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(update) : null;
	if (firstFrame === null) update();
	viewport.addEventListener("resize", update);
	viewport.addEventListener("scroll", update);
	window.addEventListener("resize", update);
	document.addEventListener("focusin", afterFocus);
	document.addEventListener("focusout", afterFocus);
	return () => {
		if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
		viewport.removeEventListener("resize", update);
		viewport.removeEventListener("scroll", update);
		window.removeEventListener("resize", update);
		document.removeEventListener("focusin", afterFocus);
		document.removeEventListener("focusout", afterFocus);
		root.style.removeProperty("--kb-inset");
		delete root.dataset.kb;
	};
}
