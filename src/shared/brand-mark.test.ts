/**
 * One mark everywhere: every brand SVG in resources/ (app icon sources, tray
 * template source, tiles, lockups) is generated from brand-mark.ts by
 * `bun run gen:icons`; the checked-in files must match what it would write.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND_SVGS } from "../../scripts/brand-svgs";
import { BRAND_MARK, knotFormForSize } from "./brand-mark";

const RESOURCES = path.join(__dirname, "..", "..", "resources");

describe("brand mark sources", () => {
	it.each(Object.entries(BRAND_SVGS))("%s is up to date (run `bun run gen:icons`)", (file, expected) => {
		expect(fs.readFileSync(path.join(RESOURCES, file), "utf8")).toBe(expected);
	});

	it("every brand SVG in resources is generated", () => {
		const onDisk = [
			...fs.readdirSync(RESOURCES).filter(name => name.endsWith(".svg")),
			...fs
				.readdirSync(path.join(RESOURCES, "brand"))
				.filter(name => name.endsWith(".svg"))
				.map(name => `brand/${name}`),
		];
		expect(onDisk.sort()).toEqual(Object.keys(BRAND_SVGS).sort());
	});

	it("the knot strands weave: each form cuts the other strand where it passes under", () => {
		for (const knot of [BRAND_MARK.full, BRAND_MARK.small]) {
			expect(knot.cutWidth).toBeGreaterThan(knot.strokeWidth);
			expect(knot.under.cx).toBeLessThan(0);
		}
		expect(BRAND_MARK.full.ring).not.toBeNull();
		expect(BRAND_MARK.small.ring).toBeNull();
		expect(BRAND_MARK.small.groove).toBeNull();
	});

	it("uses the simplified knot up to 48px and the full emblem above", () => {
		expect(knotFormForSize(16)).toBe("small");
		expect(knotFormForSize(48)).toBe("small");
		expect(knotFormForSize(49)).toBe("full");
	});

	it("generated raster assets exist", () => {
		for (const file of [
			"icon.png",
			"icon.icns",
			"icon.ico",
			"brand/tray.png",
			"brand/tray@2x.png",
			"brand/trayTemplate.png",
			"brand/trayTemplate@2x.png",
		]) {
			expect(fs.existsSync(path.join(RESOURCES, file)), file).toBe(true);
		}
	});
});
