/**
 * ompdesk token contract.
 *
 * 1. The stylesheet palettes (theme-*.css + the aliases and derived colors in
 *    tokens.css) and the named-theme maps THEMES.light / THEMES.dark resolve
 *    to the same color for every --omp-* key, and scTokensFor() mirrors the
 *    same --sc-* primitives — so picking "OMPdesk Light"/"OMPdesk Dark" by name looks
 *    exactly like following the OS.
 * 2. Contrast floors (lib/theme-contrast.ts): text ≥ 4.5:1 on every surface;
 *    interactive boundaries and the focus ring ≥ 3:1.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SC_TOKEN_SOURCES, type ScTokenKey, scTokensFor, THEME_TOKEN_KEYS, THEMES } from "../lib/themes";

type Scheme = "light" | "dark";

const dir = join(import.meta.dirname, ".");

function declarations(file: string, selector: string): Record<string, string> {
	const css = readFileSync(join(dir, file), "utf8");
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`${selector} not found in ${file}`);
	const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
	const out: Record<string, string> = {};
	for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g))
		out[match[1]] = match[2].replace(/\s+/g, " ").trim();
	return out;
}

const SHARED = declarations("tokens.css", ":root");
const PALETTES: Record<Scheme, Record<string, string>> = {
	light: declarations("theme-light.css", ':root[data-theme="light"]'),
	dark: declarations("theme-dark.css", ':root[data-theme="dark"]'),
};

function hexToRgb(hex: string): [number, number, number] {
	return [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** Fully resolve a declared value: var() chains and alpha color-mix with transparent. */
function resolve(value: string, lookup: (name: string) => string | undefined): string {
	const mix = /^color-mix\(in srgb, var\((--[a-z0-9-]+)\) (\d+)%, transparent\)$/.exec(value);
	if (mix) {
		const base = resolve(lookup(mix[1]) ?? "", lookup);
		const [r, g, b] = hexToRgb(base);
		return `rgba(${r}, ${g}, ${b}, ${Number(mix[2]) / 100})`;
	}
	return value.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => {
		const next = lookup(name);
		if (next === undefined) throw new Error(`unresolved ${name}`);
		return resolve(next, lookup);
	});
}

function cssValue(scheme: Scheme, name: string): string {
	const lookup = (key: string) => PALETTES[scheme][key] ?? SHARED[key];
	const raw = lookup(name);
	if (raw === undefined) throw new Error(`${scheme}: ${name} is not declared`);
	return resolve(raw, lookup).toLowerCase();
}

function themeValue(scheme: Scheme, name: string): string {
	const tokens: Record<string, string> = THEMES[scheme].tokens;
	return resolve(tokens[name], key => tokens[key]).toLowerCase();
}

function luminance(hex: string): number {
	return hexToRgb(hex).reduce((sum, channel, i) => {
		const c = channel / 255;
		return sum + [0.2126, 0.7152, 0.0722][i] * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	}, 0);
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe.each(["light", "dark"] as const)("ompdesk %s palette", scheme => {
	const sc = (token: string) => cssValue(scheme, `--sc-${token}`);

	it("named theme map matches the stylesheet for every --omp-* token", () => {
		const drift = THEME_TOKEN_KEYS.filter(key => cssValue(scheme, key) !== themeValue(scheme, key)).map(
			key => `${key}: css ${cssValue(scheme, key)} ≠ THEMES ${themeValue(scheme, key)}`,
		);
		expect(drift).toEqual([]);
	});

	it("scTokensFor mirrors the stylesheet --sc-* primitives", () => {
		const mirrored = scTokensFor(THEMES[scheme]);
		for (const key of Object.keys(SC_TOKEN_SOURCES) as ScTokenKey[]) {
			expect(mirrored[key].toLowerCase(), key).toBe(cssValue(scheme, key));
		}
	});

	it("keeps text at 4.5:1 on every surface", () => {
		for (const surface of ["bg", "surface-1", "surface-2", "surface-3", "elevated", "field"]) {
			for (const text of [
				"text",
				"text-secondary",
				"text-muted",
				"text-subtle",
				"accent",
				"success",
				"warning",
				"danger",
				"info",
			]) {
				expect(contrast(sc(text), sc(surface)), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
			}
		}
		expect(contrast(sc("accent-fg"), sc("accent")), "accent-fg on accent").toBeGreaterThanOrEqual(4.5);
		expect(contrast(sc("accent-fg"), sc("accent-hover")), "accent-fg on accent-hover").toBeGreaterThanOrEqual(4.5);
		expect(contrast(sc("danger-fg"), sc("danger")), "danger-fg on danger").toBeGreaterThanOrEqual(4.5);
	});

	it("keeps interactive boundaries and the focus ring at 3:1", () => {
		for (const surface of ["bg", "surface-1", "elevated", "field"]) {
			expect(contrast(sc("border"), sc(surface)), `border on ${surface}`).toBeGreaterThanOrEqual(3);
			expect(contrast(sc("accent"), sc(surface)), `focus ring on ${surface}`).toBeGreaterThanOrEqual(3);
		}
		expect(contrast(sc("text-muted"), sc("field")), "switch knob (off) on field").toBeGreaterThanOrEqual(3);
	});
});

describe("named themes on the --sc-* layer", () => {
	it("picks the more legible primary-button ink as the accent foreground", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			const { "--sc-accent": accent, "--sc-accent-fg": fg } = scTokensFor(theme);
			const other =
				fg === theme.tokens["--omp-btn-primary-text"]
					? theme.tokens["--omp-btn-primary-bg"]
					: theme.tokens["--omp-btn-primary-text"];
			if (!/^#[0-9a-f]{6}$/i.test(other)) continue;
			expect(contrast(fg, accent), name).toBeGreaterThanOrEqual(contrast(other, accent));
		}
	});
});

describe("hairline and spinner clock tokens", () => {
	const tokens = readFileSync(join(dir, "tokens.css"), "utf8");
	const global = readFileSync(join(dir, "global.css"), "utf8");
	const components = readFileSync(join(dir, "components.css"), "utf8");

	it("draws hairlines one device pixel thin on dense screens", () => {
		expect(SHARED["--sc-hairline"]).toBe("1px");
		const dense = /@media \(min-resolution: 2dppx\) \{\s*:root \{\s*--sc-hairline: 0\.5px;/.exec(tokens);
		expect(dense, "a 2dppx override of --sc-hairline").not.toBeNull();
		// Every divider rule in the component sheet uses the token, not a literal 1px.
		expect(components).not.toMatch(/\b1px solid var\(--sc-divider\)/);
		expect(components).toMatch(/var\(--sc-hairline\) solid var\(--sc-divider\)/);
	});

	it("turns every spinner on one clock", () => {
		expect(SHARED["--sc-motion-spin"]).toMatch(/^\d+ms$/);
		expect(global).toMatch(/--animate-spin: spin var\(--sc-motion-spin\) linear infinite;/);
	});
});
