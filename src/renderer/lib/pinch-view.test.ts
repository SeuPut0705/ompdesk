import { describe, expect, it } from "vitest";
import { FIT_VIEW, MAX_PINCH_SCALE, panView, pinchView, tapView } from "./pinch-view";

const box = { width: 400, height: 600 };

describe("pinchView: two fingers zoom a picture around the point between them", () => {
	it("doubles the scale when the fingers spread twice as far, keeping the point under them in place", () => {
		const view = pinchView(
			FIT_VIEW,
			[
				{ x: 150, y: 300 },
				{ x: 250, y: 300 },
			],
			[
				{ x: 100, y: 300 },
				{ x: 300, y: 300 },
			],
			box,
		);
		expect(view.scale).toBe(2);
		// The picture point at (200, 300) is still at (200, 300): 200 = x + 200 × 2.
		expect(view).toEqual({ scale: 2, x: -200, y: -300 });
	});

	it("never goes below the fit or past the maximum, and never shows an empty edge", () => {
		const out = pinchView(
			{ scale: 2, x: -200, y: -300 },
			[
				{ x: 100, y: 300 },
				{ x: 300, y: 300 },
			],
			[
				{ x: 190, y: 300 },
				{ x: 210, y: 300 },
			],
			box,
		);
		expect(out).toEqual(FIT_VIEW);
		const far = pinchView(
			FIT_VIEW,
			[
				{ x: 199, y: 300 },
				{ x: 201, y: 300 },
			],
			[
				{ x: 0, y: 300 },
				{ x: 400, y: 300 },
			],
			box,
		);
		expect(far.scale).toBe(MAX_PINCH_SCALE);
		// Fingers moved to the very left: the picture's left edge stops at the box's.
		const edge = pinchView(
			FIT_VIEW,
			[
				{ x: 150, y: 300 },
				{ x: 250, y: 300 },
			],
			[
				{ x: 300, y: 300 },
				{ x: 500, y: 300 },
			],
			box,
		);
		expect(edge.x).toBe(0);
	});
});

describe("panView and tapView", () => {
	it("moves a zoomed picture with one finger, never a fitted one, and stops at its edges", () => {
		expect(panView(FIT_VIEW, { x: 50, y: 50 }, box)).toEqual(FIT_VIEW);
		const zoomed = { scale: 2, x: -200, y: -300 };
		expect(panView(zoomed, { x: 80, y: -40 }, box)).toEqual({ scale: 2, x: -120, y: -340 });
		expect(panView(zoomed, { x: 500, y: 0 }, box).x).toBe(0);
		expect(panView(zoomed, { x: -500, y: 0 }, box).x).toBe(-400);
	});

	it("zooms in around the tapped point, and back to the fit on the next tap", () => {
		const view = tapView(FIT_VIEW, { x: 100, y: 200 }, box);
		expect(view).toEqual({ scale: 2.5, x: -150, y: -300 });
		expect(tapView(view, { x: 100, y: 200 }, box)).toEqual(FIT_VIEW);
	});
});
