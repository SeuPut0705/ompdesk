import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BRAND_MARK } from "../../../shared/brand-mark";
import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
	it("draws the pixel-grid π at sidebar size and the full mark at hero size", () => {
		const small = renderToStaticMarkup(<BrandMark size={18} />);
		expect(small).toContain(`d="${BRAND_MARK.small.ink}"`);
		expect(small).toContain(`d="${BRAND_MARK.small.accent}"`);

		const full = renderToStaticMarkup(<BrandMark size={72} />);
		expect(full).toContain(`d="${BRAND_MARK.full.ink}"`);
		expect(full).toContain(`d="${BRAND_MARK.full.accent}"`);
	});

	it("paints the foot in the theme accent, or in currentColor when mono", () => {
		expect(renderToStaticMarkup(<BrandMark size={18} />)).toContain('fill="var(--sc-accent, var(--omp-accent))"');
		expect(renderToStaticMarkup(<BrandMark size={18} variant="mono" />)).not.toContain("--sc-accent");
	});

	it("gives each tile its own gradients so two tiles on a page never share one", () => {
		const html = renderToStaticMarkup(
			<>
				<BrandMark size={18} variant="tile" />
				<BrandMark size={72} variant="tile" />
			</>,
		);
		const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1]);
		expect(ids).toHaveLength(4);
		expect(new Set(ids).size).toBe(4);
		for (const id of ids) expect(html).toContain(`fill="url(#${id})"`);
	});

	it("paints the tile with a platinum π and an indigo foot on the ink tile", () => {
		const html = renderToStaticMarkup(<BrandMark size={64} variant="tile" />);
		expect(html).toContain(`fill="${BRAND_MARK.tile.background}"`);
		expect(html).toContain(`stop-color="${BRAND_MARK.tile.ink[0][1]}"`);
		expect(html).toContain(`stop-color="${BRAND_MARK.tile.accent[0][1]}"`);
	});
});
