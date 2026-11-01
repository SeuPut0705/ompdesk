/**
 * The themes that start from a published palette keep its colors (settings-layout-look.md › Themes): every role
 * theme-sources.ts names is that published color, or, where the color fails its contrast floor, the color mixed toward
 * the theme's text by the smallest 0.01 step that passes. A shade further than the floor needs is drift.
 */

import { describe, expect, it } from "vitest";
import { buildTheme, type ThemePalette } from "./theme-builder";
import { mix } from "./theme-color";
import { contrastPairs, textFloorFor } from "./theme-contrast";
import { githubLight, gruvboxDark, nord, solarizedLight, tokyoNight } from "./theme-palettes";
import { PUBLISHED_ROLES } from "./theme-sources";
import { THEMES, type ThemeName } from "./themes";

const PALETTES: Partial<Record<ThemeName, ThemePalette>> = {
	"github-light": githubLight,
	"solarized-light": solarizedLight,
	nord,
	"tokyo-night": tokyoNight,
	"gruvbox-dark": gruvboxDark,
};

const PUBLISHED = Object.entries(PUBLISHED_ROLES) as [ThemeName, Readonly<Record<string, string>>][];

function read(palette: ThemePalette, role: string): unknown {
	return role.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], palette);
}

/** The palette with one role replaced (arrays and records copied, never mutated). */
function withRole(palette: ThemePalette, role: string, value: string): ThemePalette {
	const [head, index] = role.split(".") as [keyof ThemePalette, string | undefined];
	if (index === undefined) return { ...palette, [head]: value };
	const group = palette[head] as Record<string, string> | readonly string[];
	const copy = Array.isArray(group) ? [...group] : { ...(group as Record<string, string>) };
	(copy as Record<string, string>)[index] = value;
	return { ...palette, [head]: copy };
}

function holdsFloors(palette: ThemePalette, name: ThemeName): boolean {
	return contrastPairs(buildTheme(palette), textFloorFor(name)).every(pair => pair.ratio >= pair.floor);
}

const STEPS = Array.from({ length: 100 }, (_, i) => (i + 1) / 100);

describe.each(PUBLISHED)("%s follows its published palette", (name, roles) => {
	const palette = PALETTES[name] as ThemePalette;

	it("is the palette the app shows", () => {
		expect(buildTheme(palette)).toEqual(THEMES[name]);
	});

	it("uses each published color as is, or shaded toward the text only as far as its floor needs", () => {
		const drift: string[] = [];
		for (const [role, published] of Object.entries(roles)) {
			const value = read(palette, role);
			if (typeof value !== "string") {
				drift.push(`${role}: not a palette role`);
				continue;
			}
			if (value.toLowerCase() === published.toLowerCase()) continue;
			const minimal = STEPS.map(t => mix(published, palette.text, t)).find(shade =>
				holdsFloors(withRole(palette, role, shade), name),
			);
			if (!STEPS.some(t => mix(published, palette.text, t) === value.toLowerCase())) {
				drift.push(
					`${role}: ${value} is neither ${published} nor a shade of it (needs ${minimal ?? "none passes"})`,
				);
			} else if (holdsFloors(withRole(palette, role, published), name)) {
				drift.push(`${role}: ${published} holds its floor as published, ${value} shades it for nothing`);
			} else if (minimal !== value.toLowerCase()) {
				drift.push(`${role}: ${value} shades ${published} past ${minimal}, the first step that holds its floor`);
			}
		}
		expect(drift).toEqual([]);
	});
});
