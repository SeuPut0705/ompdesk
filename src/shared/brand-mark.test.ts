/**
 * One mark everywhere: every hand-written brand SVG (app icon source, tray
 * template source, tile, lockups) must draw exactly the geometry the in-app
 * BrandMark renders from brand-mark.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND_MARK } from "./brand-mark";

const RESOURCES = path.join(__dirname, "..", "..", "resources");
const SOURCES = [
	"icon-source.svg",
	"brand/mark.svg",
	"brand/mark-mono.svg",
	"brand/mark-tile.svg",
	"brand/wordmark-light.svg",
	"brand/wordmark-dark.svg",
];

describe("brand mark sources", () => {
	it.each(SOURCES)("%s draws the shared mark geometry", file => {
		const svg = fs.readFileSync(path.join(RESOURCES, file), "utf8");
		const { cx, cy, r } = BRAND_MARK.accentTerminal;
		expect(svg).toContain(`d="${BRAND_MARK.ink}"`);
		expect(svg).toContain(`d="${BRAND_MARK.accent}"`);
		expect(svg).toContain(`stroke-width="${BRAND_MARK.strokeWidth}"`);
		expect(svg).toContain(`<circle cx="${cx}" cy="${cy}" r="${r}"`);
	});

	it("the tile matches the in-app tile variant", () => {
		const svg = fs.readFileSync(path.join(RESOURCES, "brand/mark-tile.svg"), "utf8");
		const { radius, glyphScale, background, ink, accent } = BRAND_MARK.tile;
		expect(svg).toContain(`rx="${radius}" fill="${background}"`);
		expect(svg).toContain(`scale(${glyphScale})`);
		expect(svg).toContain(`stroke="${ink}"`);
		expect(svg).toContain(`stroke="${accent}"`);
	});

	it("generated raster assets exist", () => {
		for (const file of ["icon.png", "icon.icns", "icon.ico", "brand/trayTemplate.png", "brand/trayTemplate@2x.png"]) {
			expect(fs.existsSync(path.join(RESOURCES, file)), file).toBe(true);
		}
	});
});
