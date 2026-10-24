/**
 * A phone's page never zooms: the viewport meta (`maximum-scale=1, user-scalable=no`) and `touch-action: pan-x pan-y`
 * stop Chrome's pinch and double-tap zoom, but iOS Safari ignores both for a pinch (an accessibility choice since
 * iOS 10) and zooms the whole app, its bars and composer off screen. WebKit announces that pinch with its own
 * `gesturestart`/`gesturechange` events before it zooms, and refusing them is the one way to keep it. Pointer and
 * touch events still reach the page, so a view that handles its own pinch (the preview stream) keeps it.
 */
const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

export function blockPageZoom(
	target: Pick<Document, "addEventListener" | "removeEventListener"> = document,
): () => void {
	const refuse = (event: Event) => event.preventDefault();
	for (const name of GESTURE_EVENTS) target.addEventListener(name, refuse, { passive: false });
	return () => {
		for (const name of GESTURE_EVENTS) target.removeEventListener(name, refuse);
	};
}
