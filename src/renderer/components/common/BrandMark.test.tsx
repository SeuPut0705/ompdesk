import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BRAND_MARK } from "../../../shared/brand-mark";
import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
	it("draws the simplified knot at sidebar size and the full emblem at hero size", () => {
		const small = renderToStaticMarkup(<BrandMark size={18} />);
		expect(small).toContain(`d="${BRAND_MARK.small.strand}"`);
		expect(small).not.toContain("<circle r=");

		const full = renderToStaticMarkup(<BrandMark size={72} />);
		expect(full).toContain(`d="${BRAND_MARK.full.strand}"`);
		expect(full).toContain(`d="${BRAND_MARK.full.groove?.d}"`);
		expect(full).toContain(`r="${BRAND_MARK.full.ring?.ink.r}"`);
	});

	it("gives each instance its own mask so two marks on a page never share one", () => {
		const html = renderToStaticMarkup(
			<>
				<BrandMark size={18} />
				<BrandMark size={72} />
			</>,
		);
		const ids = [...html.matchAll(/<mask id="([^"]+)"/g)].map(match => match[1]);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		for (const id of ids) expect(html).toContain(`mask="url(#${id})"`);
	});

	it("paints the tile in platinum and gold on the ink tile", () => {
		const html = renderToStaticMarkup(<BrandMark size={64} variant="tile" />);
		expect(html).toContain(`fill="${BRAND_MARK.tile.background}"`);
		expect(html).toContain('stop-color="#F5F5F7"');
		expect(html).toContain('stop-color="#E2C990"');
	});
});
