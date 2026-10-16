/**
 * On-screen keyboard tracking for the mobile shell. Chrome on Android resizes the layout viewport when the
 * keyboard opens (`interactive-widget=resizes-content`); iOS Safari only shrinks the visual viewport and
 * scrolls the page. `--kb-inset` is the part of the layout viewport the keyboard covers
 * (`innerHeight − visualViewport.height − offsetTop`), 0 where the layout already resized, so the composer's
 * `bottom: max(var(--safe-b), var(--kb-inset))` is right on both. `html[data-kb="open"]` marks a keyboard tall
 * enough not to be browser chrome (the safe-area inset is under it, so CSS drops it).
 */

const KEYBOARD_MIN_PX = 80;

export function keyboardInset(viewport: Pick<VisualViewport, "height" | "offsetTop">, innerHeight: number): number {
	return Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop));
}

export function startKeyboardInset(root: HTMLElement = document.documentElement): () => void {
	const viewport = window.visualViewport;
	if (!viewport) return () => {};
	const update = () => {
		const inset = keyboardInset(viewport, window.innerHeight);
		root.style.setProperty("--kb-inset", `${inset}px`);
		if (inset >= KEYBOARD_MIN_PX) root.dataset.kb = "open";
		else delete root.dataset.kb;
		// iOS scrolls the (fixed) page to reveal the focused field; the shell never scrolls.
		if (inset >= KEYBOARD_MIN_PX && (window.scrollY !== 0 || window.scrollX !== 0)) window.scrollTo(0, 0);
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
