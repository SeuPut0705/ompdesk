/**
 * The picture viewer's own zoom on a touch screen: a phone's page never zooms (`no-page-zoom.ts`), so the viewer
 * scales its picture itself. A view is `translate(x, y) scale(scale)` with the transform origin at the box's top left;
 * the picture fills the box at scale 1. Pure, so the gesture's math is tested without a browser.
 */

export interface PinchView {
	scale: number;
	x: number;
	y: number;
}

export interface Point {
	x: number;
	y: number;
}

export interface Box {
	width: number;
	height: number;
}

export const FIT_VIEW: PinchView = { scale: 1, x: 0, y: 0 };
export const MAX_PINCH_SCALE = 8;
/** How far a tap zooms in when the picture fits. */
export const TAP_ZOOM_SCALE = 2.5;

/** Keeps the scale in [1, max] and the scaled picture covering the box (no empty edge dragged into view). */
export function clampView(view: PinchView, box: Box): PinchView {
	const scale = Math.min(MAX_PINCH_SCALE, Math.max(1, view.scale));
	const x = Math.min(0, Math.max(box.width - box.width * scale, view.x));
	const y = Math.min(0, Math.max(box.height - box.height * scale, view.y));
	return { scale, x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Two fingers from (a0, b0) to (a1, b1): the scale follows their distance, and the picture point that sat under
 * their midpoint stays under it (so the picture moves with the fingers too).
 */
export function pinchView(start: PinchView, from: [Point, Point], to: [Point, Point], box: Box): PinchView {
	const before = distance(from[0], from[1]);
	if (before < 1) return start;
	const m0 = midpoint(from[0], from[1]);
	const m1 = midpoint(to[0], to[1]);
	const scale = Math.min(MAX_PINCH_SCALE, Math.max(1, start.scale * (distance(to[0], to[1]) / before)));
	const px = (m0.x - start.x) / start.scale;
	const py = (m0.y - start.y) / start.scale;
	return clampView({ scale, x: m1.x - px * scale, y: m1.y - py * scale }, box);
}

/** One finger moves a zoomed picture; a fitted one stays put. */
export function panView(start: PinchView, delta: Point, box: Box): PinchView {
	if (start.scale <= 1) return start;
	return clampView({ ...start, x: start.x + delta.x, y: start.y + delta.y }, box);
}

/** A tap: back to the fit when zoomed, else in to {@link TAP_ZOOM_SCALE} around the tapped point. */
export function tapView(view: PinchView, at: Point, box: Box): PinchView {
	if (view.scale > 1) return FIT_VIEW;
	return clampView({ scale: TAP_ZOOM_SCALE, x: at.x - at.x * TAP_ZOOM_SCALE, y: at.y - at.y * TAP_ZOOM_SCALE }, box);
}
