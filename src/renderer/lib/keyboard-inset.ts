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

export function startKeyboardInset(root: HTMLElement = document.documentElement): () => void {
	const viewport = window.visualViewport;
	if (!viewport) return () => {};
	const update = () => {
		const inset = keyboardInset(viewport, window.innerHeight);
		root.style.setProperty("--kb-inset", `${inset}px`);
		if (inset >= KEYBOARD_MIN_PX) root.dataset.kb = "open";
		else delete root.dataset.kb;
		// iOS scrolls the (fixed) page to reveal the focused field; the shell never scrolls. A zoomed page's
		// pan is the user's own.
		if (inset >= KEYBOARD_MIN_PX && viewport.scale <= ZOOMED_SCALE && (window.scrollY !== 0 || window.scrollX !== 0))
			window.scrollTo(0, 0);
	};
	update();
	viewport.addEventListener("resize", update);
	viewport.addEventListener("scroll", update);
	return () => {
		viewport.removeEventListener("resize", update);
		viewport.removeEventListener("scroll", update);
		root.style.removeProperty("--kb-inset");
		delete root.dataset.kb;
	};
}
