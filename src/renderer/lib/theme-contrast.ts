/**
 * Every foreground/background pair a theme must hold, with its WCAG 2 floor:
 * text (body, secondary, muted, dim, links, status colors, syntax, diff lines,
 * the terminal's ANSI 16, button labels) 4.5:1 on the surfaces it is drawn on,
 * 7:1 in the High Contrast themes; interface boundaries (input outlines, the
 * focus ring, chart series, the accent as a graphic) 3:1. Read by
 * themes.contrast.test.ts, which fails under a floor, and by the audit script
 * that prints the worst pairs.
 */

import { contrastRatio, flatten, mix, withAlpha } from "./theme-color";
import { resolveTokenColor, THEMES, type ThemeDefinition, type ThemeName, type ThemeTokenKey } from "./themes";

export const AA_TEXT = 4.5;
export const AAA_TEXT = 7;
export const UI_BOUNDARY = 3;
/** How far a waiting session's warning title on the sidebar's selected row leans toward the text color. */
export const SELECTED_WARNING_MIX = 0.2;
/** How far a status color drawn as text on its own soft wash (`--sc-*-on-soft`: badges, chips) leans toward the text color. */
export const STATUS_ON_SOFT_MIX = 0.35;

/** The surfaces body text sits on. */
const TEXT_SURFACES: ThemeTokenKey[] = [
	"--omp-bg-primary",
	"--omp-bg-secondary",
	"--omp-bg-tertiary",
	"--omp-bg-elevated",
	"--omp-sidebar-bg",
	"--omp-code-bg",
];

/** A token as the page paints it over `base` (an rgba wash is composited, a var() resolved). */
function paint(theme: ThemeDefinition, key: ThemeTokenKey, base: string): string {
	return flatten(resolveTokenColor(theme, key), base);
}

function surface(theme: ThemeDefinition, key: ThemeTokenKey): string {
	return paint(theme, key, theme.tokens["--omp-bg-primary"]);
}

export interface ContrastPair {
	label: string;
	ratio: number;
	floor: number;
}

/** Every pair a theme must hold, named for the failure message. */
export function contrastPairs(name: ThemeName): ContrastPair[] {
	const theme = THEMES[name];
	const text = name.startsWith("hc-") ? AAA_TEXT : AA_TEXT;
	const out: ContrastPair[] = [];
	const add = (label: string, fg: string, bg: string, floor: number) =>
		out.push({ label: `${label} ${fg} on ${bg}`, ratio: contrastRatio(fg, bg), floor });

	for (const surfaceKey of TEXT_SURFACES) {
		const bg = surface(theme, surfaceKey);
		for (const key of [
			"--omp-text",
			"--omp-text-secondary",
			"--omp-muted",
			"--omp-dim",
			"--omp-accent",
			"--omp-md-link",
			"--omp-success",
			"--omp-warning",
			"--omp-error",
			"--omp-info",
		] as const) {
			add(`${key} (${surfaceKey})`, paint(theme, key, bg), bg, text);
		}
	}

	const code = surface(theme, "--omp-code-bg");
	for (const key of [
		"--omp-syntax-comment",
		"--omp-syntax-keyword",
		"--omp-syntax-function",
		"--omp-syntax-variable",
		"--omp-syntax-string",
		"--omp-syntax-number",
		"--omp-syntax-type",
		"--omp-syntax-operator",
		"--omp-syntax-punctuation",
		"--omp-md-code",
	] as const) {
		add(key, paint(theme, key, code), code, text);
	}

	// Diff lines sit on their own wash over the page and over a code block.
	for (const base of ["--omp-bg-primary", "--omp-code-bg"] as const) {
		for (const [fg, wash] of [
			["--omp-diff-added", "--omp-diff-added-bg"],
			["--omp-diff-removed", "--omp-diff-removed-bg"],
		] as const) {
			const bg = flatten(resolveTokenColor(theme, wash), surface(theme, base));
			add(`${fg} on ${wash} over ${base}`, paint(theme, fg, bg), bg, text);
		}
	}

	// Status colors on their washes (toasts, tool errors, badges).
	for (const [fg, wash] of [
		["--omp-success", "--omp-success-dim"],
		["--omp-warning", "--omp-warning-dim"],
		["--omp-error", "--omp-error-dim"],
		["--omp-info", "--omp-info-dim"],
		["--omp-accent", "--omp-accent-dim"],
	] as const) {
		const bg = flatten(resolveTokenColor(theme, wash), surface(theme, "--omp-bg-primary"));
		add(`${fg} on ${wash}`, paint(theme, fg, bg), bg, text);
	}

	// Filled buttons, badges and a selected line.
	add("btn-primary", surface(theme, "--omp-btn-primary-text"), surface(theme, "--omp-btn-primary-bg"), text);
	add("btn-danger", surface(theme, "--omp-btn-danger-text"), surface(theme, "--omp-btn-danger-bg"), text);
	add("badge", surface(theme, "--omp-badge-text"), surface(theme, "--omp-badge-bg"), text);
	const selected = flatten(resolveTokenColor(theme, "--omp-selection-bg"), surface(theme, "--omp-bg-primary"));
	add("text over selection", surface(theme, "--omp-text"), selected, text);

	// The sidebar's current session sits on a 9 % text wash (global.css `--sc-sidebar-row-selected`); there its quiet
	// text reads at secondary (`--sc-text-subtle` and `--sc-text-muted` are lifted to it; muted alone fell under 4.5:1 on solarized-light and sepia) and a waiting title's warning is mixed a fifth toward
	// the text color (`SELECTED_WARNING_MIX`).
	const sidebarSelected = flatten(withAlpha(surface(theme, "--omp-text"), 0.09), surface(theme, "--omp-sidebar-bg"));
	add(
		"secondary over sidebar selection",
		paint(theme, "--omp-text-secondary", sidebarSelected),
		sidebarSelected,
		text,
	);
	add(
		"waiting title over sidebar selection",
		mix(paint(theme, "--omp-warning", sidebarSelected), surface(theme, "--omp-text"), SELECTED_WARNING_MIX),
		sidebarSelected,
		text,
	);

	// Badges and chips: a status color as text on its own 12 % wash (`--sc-*-on-soft`), over every surface it is laid on
	// and the sidebar's selected row (a waiting session's badge sits there).
	for (const status of ["success", "warning", "error", "info", "accent"] as const) {
		for (const base of [...TEXT_SURFACES.map(key => surface(theme, key)), sidebarSelected]) {
			const bg = flatten(resolveTokenColor(theme, `--omp-${status}-dim`), base);
			add(
				`${status} badge on its wash over ${base}`,
				mix(paint(theme, `--omp-${status}`, bg), surface(theme, "--omp-text"), STATUS_ON_SOFT_MIX),
				bg,
				text,
			);
		}
	}

	// The terminal's 16 colors on its surface (--sc-surface-1 = the sidebar).
	const terminal = surface(theme, "--omp-sidebar-bg");
	for (const [index, color] of theme.ansi.entries()) add(`ansi ${index}`, color, terminal, text);

	// Interface boundaries and graphics: 3:1.
	for (const surfaceKey of [
		"--omp-bg-primary",
		"--omp-bg-secondary",
		"--omp-sidebar-bg",
		"--omp-bg-elevated",
	] as const) {
		const bg = surface(theme, surfaceKey);
		add(`border-strong (${surfaceKey})`, surface(theme, "--omp-border-strong"), bg, UI_BOUNDARY);
		add(`focus ring (${surfaceKey})`, theme.focusRing, bg, UI_BOUNDARY);
		add(`accent as graphic (${surfaceKey})`, surface(theme, "--omp-accent"), bg, UI_BOUNDARY);
		for (const [index, color] of theme.chart.entries())
			add(`chart ${index + 1} (${surfaceKey})`, color, bg, UI_BOUNDARY);
	}
	add("input border", surface(theme, "--omp-input-border"), surface(theme, "--omp-input-bg"), UI_BOUNDARY);
	return out;
}
