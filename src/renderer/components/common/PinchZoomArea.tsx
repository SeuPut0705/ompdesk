/**
 * An opened file zooms with two fingers on a touch screen, the way a page would, while the app's page itself never
 * zooms (`lib/no-page-zoom.ts`, the user's call of 23 Oct 2026: files and pictures zoom, the app does not). The area
 * scales its content by a transform (the views inside keep their own layout, scrollers and measurements), one finger
 * moves a zoomed view to its edge and then scrolls what is under the finger, and an unzoomed view scrolls natively.
 * Touch events only: a mouse or pen never reaches it. React attaches touch listeners as passive, so they are the
 * element's own here (a pinch must be cancelable to keep the browser from taking it). An iframe's touches never
 * reach them (rendered HTML's sandboxed frame does not zoom); the area's `touch-action` still reaches into the frame,
 * so a pinch there never zooms the page either.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { FIT_VIEW, type PinchView, type Point, panWithin, pinchView } from "../../lib/pinch-view";

interface Gesture {
	view: PinchView;
	from: [Point, Point];
}

/** The scroller under the finger, inside the area: the leftover of a pan at the zoomed view's edge scrolls it. */
function scrollerAt(target: EventTarget | null, area: HTMLElement): HTMLElement | null {
	let node = target instanceof Element ? target : null;
	while (node && node !== area) {
		if (node instanceof HTMLElement) {
			const style = getComputedStyle(node);
			const scrolls =
				(/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) ||
				(/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth);
			if (scrolls) return node;
		}
		node = node.parentElement;
	}
	return null;
}

export function PinchZoomArea({ children, className }: { children: ReactNode; className?: string }) {
	const areaRef = useRef<HTMLDivElement>(null);
	const [view, setView] = useState<PinchView>(FIT_VIEW);
	const viewRef = useRef(view);
	viewRef.current = view;

	useEffect(() => {
		const area = areaRef.current;
		if (!area) return;
		let pinch: Gesture | null = null;
		let last: Point | null = null;
		const local = (touch: Touch): Point => {
			const rect = area.getBoundingClientRect();
			return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
		};
		const box = () => ({ width: area.clientWidth, height: area.clientHeight });
		const begin = (event: TouchEvent) => {
			if (event.touches.length >= 2) {
				const a = event.touches[0];
				const b = event.touches[1];
				if (a && b) pinch = { view: viewRef.current, from: [local(a), local(b)] };
				last = null;
			} else {
				pinch = null;
				const touch = event.touches[0];
				last = touch ? local(touch) : null;
			}
		};
		const move = (event: TouchEvent) => {
			if (pinch && event.touches.length >= 2) {
				const a = event.touches[0];
				const b = event.touches[1];
				if (!a || !b) return;
				if (event.cancelable) event.preventDefault();
				setView(pinchView(pinch.view, pinch.from, [local(a), local(b)], box()));
				return;
			}
			const touch = event.touches[0];
			if (event.touches.length !== 1 || !touch || !last) return;
			const at = local(touch);
			const delta = { x: at.x - last.x, y: at.y - last.y };
			last = at;
			const current = viewRef.current;
			// An unzoomed view scrolls natively.
			if (current.scale <= 1) return;
			if (event.cancelable) event.preventDefault();
			const { view: next, leftover } = panWithin(current, delta, box());
			if (next !== current) setView(next);
			if (leftover.x !== 0 || leftover.y !== 0)
				scrollerAt(event.target, area)?.scrollBy(-leftover.x / current.scale, -leftover.y / current.scale);
		};
		area.addEventListener("touchstart", begin, { passive: true });
		area.addEventListener("touchmove", move, { passive: false });
		area.addEventListener("touchend", begin, { passive: true });
		area.addEventListener("touchcancel", begin, { passive: true });
		return () => {
			area.removeEventListener("touchstart", begin);
			area.removeEventListener("touchmove", move);
			area.removeEventListener("touchend", begin);
			area.removeEventListener("touchcancel", begin);
		};
	}, []);

	const zoomed = view.scale > 1;
	return (
		<div
			className={cx("relative min-h-0 overflow-hidden", className)}
			data-pinch-area=""
			data-pinch-zoomed={zoomed || undefined}
			ref={areaRef}
			// Zoomed, every finger is the area's (it moves the view, then scrolls); unzoomed, one finger scrolls natively.
			style={{ touchAction: zoomed ? "none" : "pan-x pan-y" }}
		>
			<div
				className="h-full"
				style={
					zoomed
						? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "0 0" }
						: undefined
				}
			>
				{children}
			</div>
		</div>
	);
}
