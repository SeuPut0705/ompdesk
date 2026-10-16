/**
 * Long press → `contextmenu`, for touch. Every right-click surface in the app (`onContextMenu`) is a long-press
 * surface on a phone without touching its owner: after 450 ms of a still finger the target gets a synthetic
 * `contextmenu` at the finger. A handler that takes it (calls `preventDefault`) swallows the click the
 * release would produce. Moving more than 8 px cancels (a scroll or a drag). The browser's own long-press
 * `contextmenu` (Android) arrives just after and is dropped so a menu never opens twice; iOS has none.
 */

export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP_PX = 8;
/** A native contextmenu this soon after ours is the same long press. */
const NATIVE_ECHO_MS = 1500;

interface Press {
	id: number;
	x: number;
	y: number;
	target: EventTarget | null;
	timer: number;
}

export function startLongPressMenu(doc: Document = document): () => void {
	let press: Press | null = null;
	let firedAt = -Infinity;
	let swallowClick = false;

	const cancel = () => {
		if (press) window.clearTimeout(press.timer);
		press = null;
	};

	const onDown = (event: PointerEvent) => {
		cancel();
		if (event.pointerType !== "touch" || !event.isPrimary) return;
		const target = event.target;
		const current: Press = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			target,
			timer: window.setTimeout(() => {
				if (press !== current) return;
				press = null;
				const menu = new MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					clientX: current.x,
					clientY: current.y,
					view: window,
				});
				const handled = !(current.target as Element | null)?.dispatchEvent(menu);
				if (!handled) return;
				firedAt = performance.now();
				swallowClick = true;
				navigator.vibrate?.(10);
			}, LONG_PRESS_MS),
		};
		press = current;
		swallowClick = false;
	};
	const onMove = (event: PointerEvent) => {
		if (!press || event.pointerId !== press.id) return;
		if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) cancel();
	};
	const onEnd = (event: PointerEvent) => {
		if (press && event.pointerId === press.id) cancel();
	};
	const onClick = (event: MouseEvent) => {
		if (!swallowClick) return;
		swallowClick = false;
		event.preventDefault();
		event.stopPropagation();
	};
	const onNative = (event: MouseEvent) => {
		if (!event.isTrusted) return;
		if (performance.now() - firedAt < NATIVE_ECHO_MS) {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};

	doc.addEventListener("pointerdown", onDown, true);
	doc.addEventListener("pointermove", onMove, true);
	doc.addEventListener("pointerup", onEnd, true);
	doc.addEventListener("pointercancel", onEnd, true);
	doc.addEventListener("click", onClick, true);
	doc.addEventListener("contextmenu", onNative, true);
	return () => {
		cancel();
		doc.removeEventListener("pointerdown", onDown, true);
		doc.removeEventListener("pointermove", onMove, true);
		doc.removeEventListener("pointerup", onEnd, true);
		doc.removeEventListener("pointercancel", onEnd, true);
		doc.removeEventListener("click", onClick, true);
		doc.removeEventListener("contextmenu", onNative, true);
	};
}
