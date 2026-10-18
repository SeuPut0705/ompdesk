/**
 * WCAG contrast over every theme × token pair (the pairs and floors live in
 * theme-contrast.ts), plus how different the themes really are. The OMPdesk
 * themes are in the list with the rest: nothing is exempt.
 */

import { describe, expect, it } from "vitest";
import { deltaE } from "./theme-color";
import { contrastPairs } from "./theme-contrast";
import { THEMES, type ThemeName } from "./themes";

const NAMES = Object.keys(THEMES) as ThemeName[];

describe("theme contrast (WCAG 2)", () => {
	it.each(NAMES)("%s holds AA for text and 3:1 for interface boundaries", name => {
		const failures = contrastPairs(name)
			.filter(pair => pair.ratio < pair.floor)
			.map(pair => `${pair.label} = ${pair.ratio.toFixed(2)} < ${pair.floor}`);
		expect(failures).toEqual([]);
	});
});

describe("themes are distinct", () => {
	/** The colors that give a theme its look: page, accent and the three loudest syntax roles. */
	const identity = (name: ThemeName): string[] => {
		const { tokens } = THEMES[name];
		return [
			tokens["--omp-bg-primary"],
			tokens["--omp-accent"],
			tokens["--omp-syntax-keyword"],
			tokens["--omp-syntax-string"],
			tokens["--omp-syntax-function"],
		];
	};
	const sameScheme = NAMES.flatMap(a =>
		NAMES.filter(b => a < b && THEMES[a].scheme === THEMES[b].scheme).map(b => [a, b] as const),
	);

	it.each(sameScheme)("%s and %s are not near-twins (mean ΔE of their identity colors ≥ 15)", (a, b) => {
		const x = identity(a);
		const y = identity(b);
		const mean = x.reduce((sum, color, i) => sum + deltaE(color, y[i] as string), 0) / x.length;
		expect(mean).toBeGreaterThanOrEqual(15);
	});

	it.each(sameScheme)("%s and %s have visibly different accents (ΔE ≥ 15)", (a, b) => {
		expect(deltaE(THEMES[a].tokens["--omp-accent"], THEMES[b].tokens["--omp-accent"])).toBeGreaterThanOrEqual(15);
	});
});
