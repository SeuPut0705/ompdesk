import { describe, expect, it } from "vitest";
import {
	cometShape,
	createLiveClock,
	edgePath,
	LIVE_LIGHT_PERIOD_MS,
	pillDelay,
	pillKeyframes,
	pillStrength,
} from "./live-light";

describe("edgePath", () => {
	const path = edgePath(260, 28, 6);

	it("closes on itself, so the loop has no seam", () => {
		const first = path.points[0];
		const last = path.points.at(-1);
		expect(last?.x).toBeCloseTo(first?.x ?? Number.NaN, 6);
		expect(last?.y).toBeCloseTo(first?.y ?? Number.NaN, 6);
		// The direction comes round a full turn and only ever grows (a pill never spins back at the wrap).
		expect(last?.angle).toBe(360);
		for (let index = 1; index < path.points.length; index++)
			expect(path.points[index]?.angle).toBeGreaterThanOrEqual(path.points[index - 1]?.angle ?? 0);
	});

	it("follows the rounded corners on the border's centre line, never cutting across them", () => {
		// Every point is on the 1 px border's centre: 0.5 px in from the box, or on a corner arc of radius 5.5.
		const inner = { left: 0.5, top: 0.5, right: 259.5, bottom: 27.5 };
		for (const point of path.points) {
			const onStraight =
				Math.abs(point.y - inner.top) < 1e-9 ||
				Math.abs(point.y - inner.bottom) < 1e-9 ||
				Math.abs(point.x - inner.left) < 1e-9 ||
				Math.abs(point.x - inner.right) < 1e-9;
			const cx = point.x < 130 ? inner.left + 5.5 : inner.right - 5.5;
			const cy = point.y < 14 ? inner.top + 5.5 : inner.bottom - 5.5;
			const onArc = Math.abs(Math.hypot(point.x - cx, point.y - cy) - 5.5) < 1e-9;
			expect(onStraight || onArc, `${point.x},${point.y}`).toBe(true);
		}
		// Each corner is drawn as an arc, not a point.
		expect(
			path.points.filter(point => Math.abs(point.x - inner.right) < 5.5 && point.y < inner.top + 5.5).length,
		).toBeGreaterThan(3);
	});

	it("measures the loop as the rounded rectangle's own length", () => {
		const r = 5.5;
		const expected = 2 * (259 - 2 * r) + 2 * (27 - 2 * r) + 2 * Math.PI * r;
		// Arcs are sampled every 15°: their chords are within 0.2 % of the arc.
		expect(path.perimeter).toBeGreaterThan(expected * 0.995);
		expect(path.perimeter).toBeLessThanOrEqual(expected);
	});

	it("draws a square corner as a tiny arc, so a pill turns it without a snap", () => {
		const square = edgePath(200, 40, 0);
		expect(square.points.length).toBe(edgePath(200, 40, 8).points.length);
		expect(square.perimeter).toBeLessThan(2 * (199 + 39));
	});
});

describe("pillKeyframes", () => {
	it("places every keyframe at its share of the distance, so the pace is even on long edges, short ones and corners", () => {
		const path = edgePath(700, 92, 16);
		const frames = pillKeyframes(path);
		expect(frames[0]?.offset).toBe(0);
		expect(frames.at(-1)?.offset).toBe(1);
		for (let index = 1; index < frames.length; index++) {
			const a = path.points[index - 1];
			const b = path.points[index];
			if (!a || !b) continue;
			const travelled = Math.hypot(b.x - a.x, b.y - a.y);
			const share = (Number(frames[index]?.offset) - Number(frames[index - 1]?.offset)) * path.perimeter;
			expect(share).toBeCloseTo(travelled, 6);
		}
		expect(
			frames.every(frame => /^translate\([\d.-]+px, [\d.-]+px\) rotate\([\d.]+deg\)$/.test(String(frame.transform))),
		).toBe(true);
	});
});

describe("the comet", () => {
	it("is 8 % of the loop (36-72 px), in as few pills as keep each one on the corner arc", () => {
		for (const [perimeter, radius] of [
			[200, 3.5],
			[560, 5.5],
			[1600, 15.5],
			[5000, 15.5],
		] as const) {
			const comet = cometShape(perimeter, radius);
			// A pill reaches its neighbour (spacing + 0.4 px long in live-comet.ts).
			const pill = comet.spacing + 0.4;
			const length = comet.spacing * (comet.count - 1) + pill;
			expect(length).toBeGreaterThanOrEqual(Math.min(Math.max(perimeter * 0.08, 36), 72) - 1);
			expect(length).toBeLessThanOrEqual(Math.min(Math.max(perimeter * 0.08, 36), 72) + 1);
			// Crossing a corner, a straight pill sags inside the arc by L² / 8r: never more than about a pixel and a half.
			expect(pill ** 2 / (8 * Math.max(radius, 2))).toBeLessThanOrEqual(1.6);
			expect(comet.count).toBeLessThanOrEqual(12);
		}
		// A rounder, longer edge draws the same comet in fewer, longer pills.
		expect(cometShape(1600, 15.5).count).toBeLessThan(cometShape(1600, 5.5).count);
	});

	it("fades from a full head to nothing at the tail's end", () => {
		expect(pillStrength(0, 10)).toBe(1);
		const strengths = Array.from({ length: 10 }, (_, rank) => pillStrength(rank, 10));
		for (let rank = 1; rank < 10; rank++) expect(strengths[rank]).toBeLessThan(strengths[rank - 1] ?? 0);
		expect(pillStrength(10, 10)).toBe(0);
	});

	it("runs each pill its spacing behind the one before, on the same loop", () => {
		const comet = { count: 5, spacing: 5 };
		expect(pillDelay(0, comet, 500)).toBe(0);
		expect(pillDelay(2, comet, 500)).toBe((10 / 500) * LIVE_LIGHT_PERIOD_MS);
	});
});

describe("the shared clock", () => {
	it("holds its origin while the window is visible, so lights that mount later are in step", () => {
		const clock = createLiveClock();
		expect(clock.origin(1000, true)).toBe(0);
		expect(clock.origin(5000, true)).toBe(0);
	});

	it("moves on by the time the window stayed hidden, so the lights resume where they rested", () => {
		const clock = createLiveClock();
		clock.origin(1000, true);
		// Several lights see the window go hidden and come back; only the first report of each counts.
		expect(clock.origin(2000, false)).toBe(0);
		expect(clock.origin(2500, false)).toBe(0);
		expect(clock.origin(3200, true)).toBe(1200);
		expect(clock.origin(3300, true)).toBe(1200);
		// Phase on resume equals phase when it went hidden: (3200 - 1200) = 2000.
		clock.origin(4000, false);
		expect(clock.origin(4100, true)).toBe(1300);
	});
});
