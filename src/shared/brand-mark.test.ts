/**
 * One mark everywhere: every brand SVG in resources/ (app icon sources, tray
 * template source, tiles, lockups) is generated from brand-mark.ts by
 * `bun run gen:icons`; the checked-in files must match what it would write.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND_SVGS, brandHtml, FAVICON_HREF } from "../../scripts/brand-svgs";
import { BRAND_MARK, piFormForSize } from "./brand-mark";

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
				// README download buttons (download-*.svg) are hand-made, not brand marks.
				.filter(name => name.endsWith(".svg") && !name.startsWith("download-"))
				.map(name => `brand/${name}`),
		];
		expect(onDisk.sort()).toEqual(Object.keys(BRAND_SVGS).sort());
	});

	it.each([
		["index.html", "desktop"],
		["web.html", "web"],
	] as const)("the renderer page %s carries the generated favicon and first-paint shell", (page, variant) => {
		const html = fs.readFileSync(path.join(__dirname, "..", "renderer", page), "utf8");
		expect(html).toContain(`href="${FAVICON_HREF}"`);
		expect(brandHtml(html, variant)).toBe(html);
	});

	it("each form is a π: one ink shape and the accent foot", () => {
		for (const pi of [BRAND_MARK.full, BRAND_MARK.small]) {
			// Bar, left leg, right leg.
			expect(pi.ink.match(/M/g)).toHaveLength(3);
			expect(pi.accent.match(/M/g)).toHaveLength(1);
		}
	});

	it("draws the small form on the 16 px pixel grid", () => {
		const px = 512 / 16;
		for (const value of `${BRAND_MARK.small.ink}${BRAND_MARK.small.accent}`.match(/[HV]-?[\d.]+/g) ?? []) {
			const steps = (Number(value.slice(1)) + 256) / px;
			// Straight edges sit on pixel boundaries; rounded corners start three quarters in.
			expect(Math.abs(steps * 4 - Math.round(steps * 4)), value).toBeLessThan(0.01);
		}
	});

	it("uses the pixel-grid π up to 48px and the full mark above", () => {
		expect(piFormForSize(16)).toBe("small");
		expect(piFormForSize(48)).toBe("small");
		expect(piFormForSize(49)).toBe("full");
	});

	it("generated raster assets exist", () => {
		for (const file of [
			"icon.png",
			"icon.icns",
			"icon.ico",
			"dmg-background.tiff",
			"brand/app-icon.png",
			"brand/social-preview.png",
			"brand/tray.png",
			"brand/tray@2x.png",
			"brand/trayTemplate.png",
			"brand/trayTemplate@2x.png",
		]) {
			expect(fs.existsSync(path.join(RESOURCES, file)), file).toBe(true);
		}
	});

	it("the social preview is the 1280x640 GitHub asks for", () => {
		const png = fs.readFileSync(path.join(RESOURCES, "brand", "social-preview.png"));
		expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 640]);
	});
});
