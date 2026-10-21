import { describe, expect, it } from "vitest";
import { withAlpha } from "./chart";

describe("chart withAlpha", () => {
	it("gives a hex token the chart's alpha, whatever its length", () => {
		expect(withAlpha("#3366ff", 0.6)).toBe("rgba(51, 102, 255, 0.6)");
		expect(withAlpha("#36f", 0.6)).toBe("rgba(51, 102, 255, 0.6)");
		expect(withAlpha("#3366ff80", 0.6)).toBe("rgba(51, 102, 255, 0.6)");
	});

	it("leaves a color it cannot read as it is", () => {
		for (const color of ["var(--sc-accent)", "rgb(1, 2, 3)", "red", "#12345", "#ggg"])
			expect(withAlpha(color, 0.5)).toBe(color);
	});
});
