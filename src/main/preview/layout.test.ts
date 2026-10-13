import { describe, expect, it } from "vitest";
import type { PreviewBounds } from "../../shared/preview";
import { applyPreviewLayout } from "./layout";

describe("preview native bounds", () => {
	it("clamps the native view to its owner window", () => {
		let bounds: PreviewBounds | undefined;
		let visible = false;
		applyPreviewLayout(
			{
				setBounds: value => {
					bounds = value;
				},
				setVisible: value => {
					visible = value;
				},
			},
			{ x: 800.2, y: 100.7, width: 500, height: 900 },
			true,
			{ width: 1000, height: 700 },
		);
		expect(bounds).toEqual({ x: 800, y: 101, width: 200, height: 599 });
		expect(visible).toBe(true);
	});
	it("hides hidden, covered, zero-sized and invalid surfaces", () => {
		for (const [bounds, show] of [
			[{ x: 0, y: 0, width: 10, height: 10 }, false],
			[{ x: 1000, y: 0, width: 10, height: 10 }, true],
			[{ x: NaN, y: 0, width: 10, height: 10 }, true],
		] as const) {
			let visible = true;
			applyPreviewLayout(
				{
					setBounds: () => {},
					setVisible: value => {
						visible = value;
					},
				},
				bounds,
				show,
				{ width: 100, height: 100 },
			);
			expect(visible).toBe(false);
		}
	});
});
