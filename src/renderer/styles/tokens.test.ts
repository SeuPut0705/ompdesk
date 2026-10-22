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

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATUS_ON_SOFT_MIX, USAGE_ALERT_FILL, USAGE_PLAIN_FILL } from "../lib/theme-contrast";
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

describe("status text on a soft wash", () => {
	it("leans toward the text color as far as the contrast pairs measure", () => {
		const status = Math.round((1 - STATUS_ON_SOFT_MIX) * 100);
		for (const name of ["accent", "success", "warning", "danger", "info"])
			expect(SHARED[`--sc-${name}-on-soft`]).toBe(
				`color-mix(in srgb, var(--sc-${name}) ${status}%, var(--sc-text))`,
			);
	});
});

describe("status text on its own soft wash", () => {
	const STATUSES = "accent|success|warning|danger|info";
	// A glyph needs 3:1, which the bare status color holds on its wash; only text needs the -on-soft color.
	const ICON_ONLY = new Set([".omp-composer-mic[data-recording],\n.omp-composer-mic[data-recording]:hover"]);

	it("draws a status color as text on that status's soft wash with --sc-<status>-on-soft, in every stylesheet", () => {
		const offenders: string[] = [];
		for (const file of readdirSync(dir).filter(name => name.endsWith(".css"))) {
			const css = readFileSync(join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
			for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
				const selector = (rule[1] ?? "").trim();
				const body = rule[2] ?? "";
				const wash = new RegExp(`background(?:-color)?:\\s*var\\(--sc-(${STATUSES})-soft\\)`).exec(body)?.[1];
				if (!wash || ICON_ONLY.has(selector)) continue;
				if (new RegExp(`(?:^|[;\\s])color:\\s*var\\(--sc-${wash}\\)`).test(body))
					offenders.push(`${file}: ${selector}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("does the same in the components' class strings", () => {
		const offenders: string[] = [];
		const walk = (folder: string) => {
			for (const entry of readdirSync(folder, { withFileTypes: true })) {
				const path = join(folder, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
					for (const line of readFileSync(path, "utf8").split("\n")) {
						const wash = new RegExp(`bg-\\(--sc-(${STATUSES})-soft\\)`).exec(line)?.[1];
						if (wash && line.includes(`text-(--sc-${wash})`)) offenders.push(`${path}: ${line.trim()}`);
					}
				}
			}
		};
		walk(join(dir, "..", "components"));
		expect(offenders).toEqual([]);
	});
});

describe("quiet text on a warning-washed row", () => {
	it("reads at secondary on the work board's waiting rows, where the contrast pairs measure it", () => {
		const css = readFileSync(join(dir, "work-board.css"), "utf8");
		const rule =
			/button\.omp-work-board-row\[data-board-opened\]\[data-status="waiting"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
		expect(rule).toContain("--sc-text-subtle: var(--sc-text-secondary);");
		expect(rule).toContain("--sc-text-muted: var(--sc-text-secondary);");
		expect(css).toMatch(
			/\.omp-work-board-section\[data-tone="warning"\] button\.omp-work-board-row,\s*button\.omp-work-board-row\[data-board-opened\]\[data-status="waiting"\] \{\s*--sc-text-subtle/,
		);
	});
});

describe("the work board's name under the phone's strip", () => {
	it("is hidden only from sight, so the sections' h3 stay under an h2 for a screen reader", () => {
		const css = readFileSync(join(dir, "mobile.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(rule =>
			(rule[1] ?? "").includes(".omp-work-strip-panel .omp-work-board-name"),
		);
		expect(rules.length).toBeGreaterThan(0);
		for (const rule of rules) expect(rule[2]).not.toMatch(/display:\s*none/);
		expect(rules.map(rule => rule[2]).join("")).toMatch(/clip-path:\s*inset\(50%\)/);
	});
});

describe("usage gauge fills", () => {
	it("are the shares the contrast table measures", () => {
		const css = readFileSync(join(dir, "usage-gauges.css"), "utf8");
		const pct = (value: number) => `${Math.round(value * 100)}%`;
		expect(css).toContain(`color-mix(in srgb, var(--sc-text) ${pct(USAGE_PLAIN_FILL)}, transparent)`);
		expect(css).toContain(`color-mix(in srgb, var(--sc-warning) ${pct(USAGE_ALERT_FILL)}, transparent)`);
		expect(css).toContain(`color-mix(in srgb, var(--sc-danger) ${pct(USAGE_ALERT_FILL)}, transparent)`);
		expect(css).toMatch(
			/\[data-state="near"\], \[data-state="limit"\]\) \.omp-usage-gauge-text > :first-child \{\s*color: var\(--sc-text\);/,
		);
	});
});

/** A selector list split at its own commas, not those inside `:is(…)` and the like. */
function topLevelList(list: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < list.length; index++) {
		const char = list[index];
		if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === "," && depth === 0) {
			parts.push(list.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(list.slice(start).trim());
	return parts;
}

describe("focus ring utilities", () => {
	it("never pair outline-none with a focus-visible outline, which it switches off", () => {
		// Tailwind 4's `outline-none` sets `--tw-outline-style: none`, and `focus-visible:outline-2` draws
		// `outline-style: var(--tw-outline-style)`: together the ring never shows (the sidebar's usage toggle, every
		// ListRow title). Without `outline-none` the base `:focus-visible` rule and the utility draw it.
		const offenders: string[] = [];
		const walk = (folder: string) => {
			for (const entry of readdirSync(folder, { withFileTypes: true })) {
				const path = join(folder, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
					for (const line of readFileSync(path, "utf8").split("\n"))
						if (
							/(?:^|[\s"`'])outline-none\b/.test(line) &&
							/focus-visible:(?:after:)?outline-(?:\d|\()/.test(line)
						)
							offenders.push(`${path}: ${line.trim().slice(0, 120)}`);
				}
			}
		};
		walk(join(dir, ".."));
		expect(offenders).toEqual([]);
	});

	it("never lists a :focus-visible selector beside one that is not, so a focus rule never styles a control at rest", () => {
		// Deleting the last selector of a shared focus rule once glued the list onto the next rule: five focused
		// work-card buttons took `.omp-live-step-icon`'s 14 px width and height and lost their ring.
		const offenders: string[] = [];
		for (const entry of readdirSync(dir)) {
			if (!entry.endsWith(".css")) continue;
			const css = readFileSync(join(dir, entry), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
			for (const match of css.matchAll(/([^{};]+)\{/g)) {
				const selectors = topLevelList(match[1] ?? "");
				if (selectors.some(selector => selector.startsWith("@"))) continue;
				// A hover twin (`:hover::after, :focus-visible::after`) is a state too.
				const atRest = selectors.filter(
					selector => !/:(?:focus-visible|focus-within|focus|hover|active)\b/.test(selector),
				);
				if (selectors.some(selector => selector.includes(":focus-visible")) && atRest.length > 0)
					offenders.push(`${entry}: ${selectors.join(", ").slice(0, 160)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("draws a phone tab's ring inside it, where the sideways tab scroller clips anything outside", () => {
		const css = readFileSync(join(dir, "mobile.css"), "utf8");
		expect(css).toMatch(
			/html\[data-shell="phone"\] \[role="tablist"\] > \[role="tab"\]:focus-visible \{\s*outline-offset: calc\(-1 \* var\(--sc-focus-width\)\);/,
		);
	});
});
