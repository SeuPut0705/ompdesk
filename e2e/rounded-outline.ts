/** A box's four corner radii in px: top-left, top-right, bottom-right, bottom-left. */
export type Radii = readonly [number, number, number, number];

/**
 * Whether a point inside a box lies in one of its rounded corners but outside the curve: a clipping scroller draws
 * nothing there, so a tap on it reaches no control. A point inside the drawn outline, however near a corner, is not.
 * Self-contained: the responsive audit passes its source into the page.
 */
export function outsideRoundedOutline(
	box: { left: number; top: number; right: number; bottom: number },
	radii: Radii,
	x: number,
	y: number,
): boolean {
	if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false;
	const most = Math.min(box.right - box.left, box.bottom - box.top) / 2;
	const corners: Array<[number, number, number, number, number]> = [
		[radii[0], box.left, box.top, 1, 1],
		[radii[1], box.right, box.top, -1, 1],
		[radii[2], box.right, box.bottom, -1, -1],
		[radii[3], box.left, box.bottom, 1, -1],
	];
	for (const [radius, edgeX, edgeY, inX, inY] of corners) {
		const r = Math.min(radius, most);
		if (r <= 0) continue;
		const cx = edgeX + inX * r;
		const cy = edgeY + inY * r;
		if ((x - cx) * inX >= 0 || (y - cy) * inY >= 0) continue;
		if (Math.hypot(x - cx, y - cy) > r) return true;
	}
	return false;
}
