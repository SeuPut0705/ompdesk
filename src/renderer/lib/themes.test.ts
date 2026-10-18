/**
 * Theme registry contract: every named theme must define the full
 * THEME_TOKEN_KEYS map — applyThemeByName writes tokens inline, so a missing
 * key silently falls back to whatever the previous theme left on <html>.
 * Contrast floors live in themes.contrast.test.ts.
 */

import { describe, expect, it } from "vitest";
import { DARK_THEME_NAMES, LIGHT_THEME_NAMES, schemeOfTheme, THEME_NAMES } from "../../shared/theme-names";
import { ANSI_KEYS, CHART_KEYS } from "./theme-builder";
import { hue } from "./theme-color";
import { THEME_TOKEN_KEYS, THEMES, type ThemeName, TRANSCRIPT_OVERLAY_VARS, themeExtrasFor } from "./themes";

const NAMES = Object.keys(THEMES) as ThemeName[];

describe("theme registry", () => {
	it("is exactly the shared id list, light group first", () => {
		expect(NAMES).toEqual([...LIGHT_THEME_NAMES, ...DARK_THEME_NAMES]);
		expect(NAMES).toEqual([...THEME_NAMES]);
	});

	it("defines every canonical token on every theme", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			const missing = THEME_TOKEN_KEYS.filter(key => !(key in theme.tokens));
			expect(missing, `${name} missing tokens: ${missing.join(", ")}`).toEqual([]);
		}
	});

	it("has no unknown tokens beyond the canonical set", () => {
		const canonical: Record<string, true> = Object.fromEntries(THEME_TOKEN_KEYS.map(key => [key, true]));
		for (const [name, theme] of Object.entries(THEMES)) {
			const extra = Object.keys(theme.tokens).filter(key => !canonical[key]);
			expect(extra, `${name} unknown tokens: ${extra.join(", ")}`).toEqual([]);
		}
	});

	it("carries picker metadata and a scheme that matches its group", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			expect(theme.label.trim().length, `${name} label`).toBeGreaterThan(0);
			expect(theme.description.trim().length, `${name} description`).toBeGreaterThan(0);
			expect(theme.scheme, name).toBe(schemeOfTheme(name as ThemeName));
		}
	});

	it("gives every theme its own terminal ANSI 16, six chart series and a focus ring", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			expect(theme.ansi, `${name} ansi`).toHaveLength(16);
			expect(theme.chart, `${name} chart`).toHaveLength(6);
			expect(new Set(theme.chart).size, `${name} chart series are distinct`).toBe(6);
			expect(theme.focusRing, `${name} focus ring`).toMatch(/^#[0-9a-f]{6}$/i);
			const extras = themeExtrasFor(theme);
			expect(Object.keys(extras).sort(), name).toEqual([...ANSI_KEYS, ...CHART_KEYS, "--sc-focus-ring"].sort());
			expect(
				Object.values(extras).every(value => /^#[0-9a-f]{6}$/i.test(value)),
				name,
			).toBe(true);
		}
	});

	it("keeps the TUI overlay off chrome tokens", () => {
		const overlay = new Set(Object.values(TRANSCRIPT_OVERLAY_VARS));
		for (const chrome of ["--omp-accent", "--omp-sidebar-bg", "--omp-titlebar-bg", "--omp-btn-primary-bg"] as const) {
			expect(overlay.has(chrome), chrome).toBe(false);
		}
	});

	it("keeps the OMPdesk dark and light accents in the same hue family", () => {
		const a = hue(THEMES.dark.tokens["--omp-accent"]);
		const b = hue(THEMES.light.tokens["--omp-accent"]);
		expect(Math.min(Math.abs(a - b), 360 - Math.abs(a - b))).toBeLessThan(30);
	});

	it("keeps purple off the OMPdesk keyword, model and custom-label roles", () => {
		for (const name of ["dark", "light"] as const) {
			for (const key of ["--omp-syntax-keyword", "--omp-status-model", "--omp-custom-msg-label"] as const) {
				const h = hue(THEMES[name].tokens[key]);
				expect(h < 260 || h > 320, `${name} ${key} hue ${h}`).toBe(true);
			}
		}
	});
});
