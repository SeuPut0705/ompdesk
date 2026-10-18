/**
 * Color-blind mode pins accent, success, warning and danger to Okabe-Ito hues (global.css), shaded per
 * scheme. Whatever theme is showing, those four must still read as text on the theme's page, cards,
 * sidebar and code surfaces (4.5:1, also over their own 12% wash), and the accent button's label on the accent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, flatten, withAlpha } from "../lib/theme-color";
import { THEMES, type ThemeName } from "../lib/themes";

const css = readFileSync(join(import.meta.dirname, "global.css"), "utf8");

function block(selector: string): Record<string, string> {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`${selector} not found in global.css`);
	const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
	return Object.fromEntries(
		Array.from(body.matchAll(/(--cb-[a-z-]+):\s*(#[0-9a-f]{6});/g), match => [match[1], match[2]]),
	);
}

const PALETTES = {
	light: block(':root[data-colorblind="true"]'),
	dark: block(':root[data-colorblind="true"][data-theme="dark"]'),
} as const;

const SURFACES = [
	"--omp-bg-primary",
	"--omp-bg-secondary",
	"--omp-bg-elevated",
	"--omp-sidebar-bg",
	"--omp-code-bg",
] as const;

const names = Object.keys(THEMES) as ThemeName[];

describe("color-blind mode palette", () => {
	it.each(names)("%s keeps the pinned accent and status colors readable", name => {
		const theme = THEMES[name];
		const palette = PALETTES[theme.scheme];
		const failures: string[] = [];
		for (const key of ["--cb-accent", "--cb-success", "--cb-warning", "--cb-danger"] as const) {
			const color = palette[key] as string;
			for (const surfaceKey of SURFACES) {
				const surface = theme.tokens[surfaceKey];
				const wash = flatten(withAlpha(color, 0.12), surface);
				for (const [on, label] of [
					[surface, "surface"],
					[wash, "wash"],
				] as const) {
					const ratio = contrastRatio(color, on);
					if (ratio < 4.5)
						failures.push(`${key} ${color} on ${label} ${on} (${surfaceKey}) = ${ratio.toFixed(2)}`);
				}
			}
		}
		const fg = contrastRatio(palette["--cb-accent-fg"] as string, palette["--cb-accent"] as string);
		if (fg < 4.5) failures.push(`accent label ${fg.toFixed(2)}`);
		expect(failures).toEqual([]);
	});

	it("keeps the four colors apart from each other in every scheme (hue or lightness)", () => {
		for (const scheme of ["light", "dark"] as const) {
			const colors = ["--cb-accent", "--cb-success", "--cb-warning", "--cb-danger"].map(
				key => PALETTES[scheme][key] as string,
			);
			expect(new Set(colors).size, scheme).toBe(4);
		}
	});
});
