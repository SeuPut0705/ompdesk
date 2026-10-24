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
	// Two fingers moving are a pinch: refused for the page whatever the browser's own zoom setting says (Chrome's
	// "Force enable zoom" and Samsung Internet's website zoom override the viewport meta and touch-action, not a
	// cancelled touch). A view that zooms itself still reads the touches and pointers: only the browser's zoom stops.
	const refusePinch = (event: Event) => {
		if ((event as TouchEvent).touches?.length > 1 && event.cancelable) event.preventDefault();
	};
	for (const name of GESTURE_EVENTS) target.addEventListener(name, refuse, { passive: false });
	target.addEventListener("touchmove", refusePinch, { passive: false });
	return () => {
		for (const name of GESTURE_EVENTS) target.removeEventListener(name, refuse);
		target.removeEventListener("touchmove", refusePinch);
	};
}
