/**
 * Touch gestures of the picture viewer (`ZoomableImage`): two fingers zoom the picture, one finger moves a zoomed one,
 * a tap zooms in or back to the fit. A phone's page never zooms (`lib/no-page-zoom.ts`), so this is how a picture gets
 * bigger there. Mouse and pen keep the viewer's own click (actual size); only `touch` pointers are read here.
 */
import { type PointerEvent, useRef, useState } from "react";
import { FIT_VIEW, type PinchView, type Point, panView, pinchView, tapView } from "../../lib/pinch-view";

/** A finger that travels this far is a gesture, and its lift is no tap. */
const TAP_SLOP_PX = 8;

interface Gesture {
	view: PinchView;
	points: Map<number, Point>;
}

export function usePinchView() {
	const [view, setView] = useState<PinchView>(FIT_VIEW);
	const viewRef = useRef(view);
	viewRef.current = view;
	const points = useRef(new Map<number, Point>());
	const gesture = useRef<Gesture | null>(null);
	const moved = useRef(false);
	const lastTouch = useRef<Point | null>(null);

	const local = (event: PointerEvent<HTMLElement>): Point => {
		const rect = event.currentTarget.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	};
	const box = (event: PointerEvent<HTMLElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		return { width: rect.width, height: rect.height };
	};
	const restart = () => {
		gesture.current = points.current.size > 0 ? { view: viewRef.current, points: new Map(points.current) } : null;
	};

	const onPointerDown = (event: PointerEvent<HTMLElement>) => {
		if (event.pointerType !== "touch") return;
		event.currentTarget.setPointerCapture?.(event.pointerId);
		if (points.current.size === 0) moved.current = false;
		points.current.set(event.pointerId, local(event));
		if (points.current.size > 1) moved.current = true;
		restart();
	};
	const onPointerMove = (event: PointerEvent<HTMLElement>) => {
		if (!points.current.has(event.pointerId) || !gesture.current) return;
		const at = local(event);
		points.current.set(event.pointerId, at);
		const start = gesture.current;
		const ids = [...points.current.keys()];
		if (ids.length >= 2) {
			const [a, b] = ids;
			const from = [start.points.get(a), start.points.get(b)];
			const to = [points.current.get(a), points.current.get(b)];
			if (from[0] && from[1] && to[0] && to[1])
				setView(pinchView(start.view, [from[0], from[1]], [to[0], to[1]], box(event)));
			return;
		}
		const origin = start.points.get(event.pointerId);
		if (!origin) return;
		const delta = { x: at.x - origin.x, y: at.y - origin.y };
		if (Math.hypot(delta.x, delta.y) > TAP_SLOP_PX) moved.current = true;
		if (moved.current) setView(panView(start.view, delta, box(event)));
	};
	const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
		if (!points.current.delete(event.pointerId)) return;
		if (event.type === "pointercancel") moved.current = true;
		lastTouch.current = local(event);
		restart();
	};

	return {
		view,
		zoomed: view.scale > 1,
		handlers: {
			onPointerDown,
			onPointerMove,
			onPointerUp: onPointerEnd,
			onPointerCancel: onPointerEnd,
		},
		/**
		 * The viewer's click, when the last pointer was a finger: a gesture's lift does nothing, a tap zooms in around
		 * the finger or back to the fit. Returns false for a mouse or pen click, which the viewer handles itself.
		 */
		touchClick(element: HTMLElement): boolean {
			const at = lastTouch.current;
			if (!at) return false;
			lastTouch.current = null;
			if (!moved.current) {
				const rect = element.getBoundingClientRect();
				setView(tapView(viewRef.current, at, { width: rect.width, height: rect.height }));
			}
			moved.current = false;
			return true;
		},
		reset() {
			points.current.clear();
			gesture.current = null;
			moved.current = false;
			lastTouch.current = null;
			setView(FIT_VIEW);
		},
	};
}
