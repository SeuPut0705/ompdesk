/**
 * The geometry and the clock of the "work is going on" light (`LiveEdge`): a comet that runs the box's rounded edge
 * clockwise at an even pace, every light of the window on one shared phase.
 *
 * The comet is a short chain of tiny pills, each moved by one compositor-only transform animation along the same
 * closed path: the two straight runs and the quarter arcs of the box's real rounded rectangle, the arcs sampled every
 * `ARC_STEP_DEG`, every keyframe placed at its distance along the edge (so the pace is the same on a long edge, a
 * short one and around a corner), and the path ends where it starts (so the loop has no seam). Pill `i` runs the
 * same path `i * spacing` px behind the head and fades with its rank, which draws the tail.
 *
 * Why this form (measured on a bench page, 3 and 12 lit 260x28 rows, Electron 36): the old two straight bars
 * 0.24 % renderer / 0.34 % GPU (3 rows) and 0.26 / 0.39 (12); this pill chain 0.26 / 0.27 and 0.49 / 0.40; an SVG
 * rect whose `stroke-dashoffset` animates (the only other form that follows the corners) 0.63 / 0.72 and 0.79 / 1.04,
 * because a dash offset repaints on the main thread every frame; `offset-path` dots ticked on the main thread too.
 *
 * The clock: every animation starts at `origin + its delay` on the document timeline, so a light that mounts later
 * (a new running row, a row that moved to another group, a remount) appears where the others are, and nothing ever
 * restarts from zero. While the window is hidden the lights rest; the time it stayed hidden moves the origin, so they
 * all go on from where they rested, still in step.
 */

/** One loop of the edge, for every light (a row's and the composer's alike: one rhythm on screen). */
export const LIVE_LIGHT_PERIOD_MS = 8000;

/** How finely a corner's quarter arc is sampled; a straight keyframe step between samples errs < 0.15 px at r 16. */
const ARC_STEP_DEG = 15;
/** Below this radius a corner is drawn as this small arc, so a pill turns a square corner without a snap. */
const MIN_RADIUS = 1.5;

export interface EdgePoint {
	x: number;
	y: number;
	/** The direction of travel, degrees clockwise from +x, growing monotonically around the loop (0 → 360). */
	angle: number;
	/** Distance along the edge from the start, px. */
	along: number;
}

export interface EdgePath {
	points: EdgePoint[];
	perimeter: number;
	/** The corner arcs' radius, px. */
	radius: number;
}

/**
 * The closed clockwise path along the centre of a 1 px border drawn on a `width` × `height` box with corner radius
 * `radius` (all px). Starts at the end of the top-left arc, heading right; its last point is its first point.
 */
export function edgePath(width: number, height: number, radius: number): EdgePath {
	const w = Math.max(width - 1, 2);
	const h = Math.max(height - 1, 2);
	const r = Math.min(Math.max(radius - 0.5, MIN_RADIUS), w / 2, h / 2);
	const raw: { x: number; y: number; angle: number }[] = [];
	const arc = (cx: number, cy: number, from: number) => {
		for (let step = ARC_STEP_DEG; step <= 90; step += ARC_STEP_DEG) {
			const theta = ((from + step) * Math.PI) / 180;
			raw.push({ x: 0.5 + cx + r * Math.cos(theta), y: 0.5 + cy + r * Math.sin(theta), angle: from + step + 90 });
		}
	};
	raw.push({ x: 0.5 + r, y: 0.5, angle: 0 });
	raw.push({ x: 0.5 + w - r, y: 0.5, angle: 0 });
	arc(w - r, r, -90);
	raw.push({ x: 0.5 + w, y: 0.5 + h - r, angle: 90 });
	arc(w - r, h - r, 0);
	raw.push({ x: 0.5 + r, y: 0.5 + h, angle: 180 });
	arc(r, h - r, 90);
	raw.push({ x: 0.5, y: 0.5 + r, angle: 270 });
	arc(r, r, 180);
	const points: EdgePoint[] = [];
	let along = 0;
	for (const [index, point] of raw.entries()) {
		const previous = raw[index - 1];
		if (previous) along += Math.hypot(point.x - previous.x, point.y - previous.y);
		points.push({ ...point, along });
	}
	return { points, perimeter: along, radius: r };
}

/** The keyframes that move one pill once around `path`, each at its share of the distance (an even pace). */
export function pillKeyframes(path: EdgePath): Keyframe[] {
	return path.points.map(point => ({
		offset: path.perimeter > 0 ? point.along / path.perimeter : 0,
		transform: `translate(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px) rotate(${point.angle}deg)`,
	}));
}

/** The shortest a pill gets along the edge, px. */
export const PILL_LENGTH = 6;

/** How far a pill crossing a corner may sag inside the arc it cuts (its sagitta), px. */
const MAX_SAG = 1.2;

export interface CometShape {
	/** Pills in the chain, head first. */
	count: number;
	/** Distance between neighbouring pills along the edge, px. */
	spacing: number;
}

/**
 * The comet for a loop of `perimeter` px whose corners are arcs of `radius` px: 8 % of the loop (36-72 px), drawn
 * with as few pills as the corners allow. Each pill animates on its own and every animating element costs the renderer
 * a style update on every main-thread frame, so pills are as long as a corner lets a straight piece be (sagging at
 * most `MAX_SAG` inside the arc: L = √(8·r·sag)), at most 12 px.
 */
export function cometShape(perimeter: number, radius: number): CometShape {
	const length = Math.min(Math.max(perimeter * 0.08, 36), 72);
	const longest = Math.min(Math.max(Math.sqrt(8 * radius * MAX_SAG), PILL_LENGTH), 12);
	const count = Math.ceil((length - longest) / longest) + 1;
	return { count, spacing: (length - longest) / (count - 1) };
}

/** Pill `rank`'s strength: the head full, the tail fading out ease-in so its end has no hard edge. */
export function pillStrength(rank: number, count: number): number {
	return Math.round((1 - rank / count) ** 1.6 * 1000) / 1000;
}

/** How far behind the head pill `rank` starts, ms of the loop. */
export function pillDelay(rank: number, comet: CometShape, perimeter: number): number {
	return perimeter > 0 ? ((rank * comet.spacing) / perimeter) * LIVE_LIGHT_PERIOD_MS : 0;
}

/**
 * The shared phase clock. `origin(now, visible)` is the document-timeline time every light's loop counts from: it
 * holds still while the window is visible and moves on by however long the window stayed hidden, so lights that
 * rested resume where they stopped and stay in step with lights that mount after.
 */
export function createLiveClock(): { origin(now: number, visible: boolean): number } {
	let origin = 0;
	let hiddenSince: number | null = null;
	return {
		origin(now, visible) {
			if (!visible && hiddenSince === null) hiddenSince = now;
			if (visible && hiddenSince !== null) {
				origin += now - hiddenSince;
				hiddenSince = null;
			}
			return origin;
		},
	};
}

export const liveClock = createLiveClock();
