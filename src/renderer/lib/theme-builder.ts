/**
 * Builds a full theme (every `--omp-*` token of THEME_TOKEN_KEYS, the terminal's
 * ANSI 16, the chart series and the focus ring) from one compact palette. A
 * theme author states the surfaces, the text tiers, the accent, the four status
 * colors, the syntax roles and the terminal colors; everything derived from them
 * (washes, rails, buttons, badges, panels, shadows) follows one rule here, so
 * twelve themes cannot drift apart in how a diff line or a toast is made.
 * The OMPdesk Light and Dark themes are spelled out token by token in themes.ts
 * because theme-light.css / theme-dark.css must match them (styles/tokens.test.ts).
 */

import { mix, withAlpha } from "./theme-color";
import type { ThemeDefinition, ThemeTokens } from "./themes";

export interface ThemePalette {
	label: string;
	description: string;
	scheme: "dark" | "light";
	/** Recognisable family a published palette comes from (shown in the picker), if any. */
	origin?: string;
	/** Page background. */
	bg: string;
	/** Sunken surface: sidebar, side panel, status bar, code blocks, terminal. */
	sunken: string;
	/** Cards and the user's message bubble. */
	secondary: string;
	/** Hover, secondary buttons, badges, progress track. */
	tertiary: string;
	/** Menus, modals, toasts. */
	elevated: string;
	text: string;
	textSecondary: string;
	muted: string;
	dim: string;
	/** Decorative dividers and card edges. */
	border: string;
	borderMuted: string;
	/** Interactive boundaries (inputs, buttons); at least 3:1 on the surfaces. */
	borderStrong: string;
	accent: string;
	/** Hover and emphasis tone of the accent. */
	accentBright: string;
	/** Ink on an accent-filled button. */
	onAccent: string;
	success: string;
	warning: string;
	error: string;
	info: string;
	/** Ink on an error-filled button. */
	onError: string;
	/** Inline `code` in prose. */
	inlineCode: string;
	syntax: {
		comment: string;
		keyword: string;
		function: string;
		variable: string;
		string: string;
		number: string;
		type: string;
		operator: string;
		punctuation: string;
	};
	/** Terminal black, red, green, yellow, blue, magenta, cyan, white. */
	ansi: readonly [string, string, string, string, string, string, string, string];
	/** The bright row; derived from `ansi` when absent. */
	ansiBright?: readonly [string, string, string, string, string, string, string, string];
	/** Categorical chart series, each at least 3:1 on the page. */
	chart: readonly [string, string, string, string, string, string];
	/** Focus ring; the accent when absent. */
	focusRing?: string;
	/** Modal scrim. */
	overlay: string;
	/** `r, g, b` of the shadow color. */
	shadow: string;
}

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** `--omp-ansi-*` keys in xterm order: the eight normal colors, then the bright row. */
export const ANSI_KEYS = [
	...ANSI_NAMES.map(name => `--omp-ansi-${name}`),
	...ANSI_NAMES.map(name => `--omp-ansi-bright-${name}`),
] as const;

export const CHART_KEYS = [
	"--omp-chart-1",
	"--omp-chart-2",
	"--omp-chart-3",
	"--omp-chart-4",
	"--omp-chart-5",
	"--omp-chart-6",
] as const;

export function ansiRow(palette: Pick<ThemePalette, "ansi" | "ansiBright" | "text">): string[] {
	const bright = palette.ansiBright ?? palette.ansi.map(color => mix(color, palette.text, 0.22));
	return [...palette.ansi, ...bright];
}

export function buildTheme(p: ThemePalette): ThemeDefinition {
	const dark = p.scheme === "dark";
	const wash = dark ? 0.12 : 0.1;
	const tokens: ThemeTokens = {
		"--omp-accent": p.accent,
		"--omp-accent-bright": p.accentBright,
		"--omp-accent-dim": withAlpha(p.accent, 0.12),
		"--omp-accent-glow": withAlpha(p.accent, 0.22),
		"--omp-border": p.border,
		"--omp-border-accent": withAlpha(p.accent, 0.55),
		"--omp-border-muted": p.borderMuted,
		"--omp-border-strong": p.borderStrong,
		"--omp-success": p.success,
		"--omp-success-dim": withAlpha(p.success, 0.12),
		"--omp-error": p.error,
		"--omp-error-dim": withAlpha(p.error, 0.12),
		"--omp-warning": p.warning,
		"--omp-warning-dim": withAlpha(p.warning, 0.12),
		"--omp-info": p.info,
		"--omp-info-dim": withAlpha(p.info, 0.12),
		"--omp-text": p.text,
		"--omp-text-secondary": p.textSecondary,
		"--omp-bg-primary": p.bg,
		"--omp-bg-secondary": p.secondary,
		"--omp-bg-tertiary": p.tertiary,
		"--omp-bg-elevated": p.elevated,
		"--omp-selected-bg": withAlpha(p.text, 0.07),
		"--omp-user-msg-bg": p.secondary,
		"--omp-user-msg-border": p.border,
		"--omp-custom-msg-bg": p.secondary,
		"--omp-code-bg": p.sunken,
		"--omp-tool-pending-bg": p.secondary,
		"--omp-tool-error-bg": withAlpha(p.error, dark ? 0.07 : 0.06),
		"--omp-tool-output": p.textSecondary,
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": p.success,
		"--omp-tool-rail-error": p.error,
		"--omp-md-heading": p.text,
		"--omp-md-link": p.accent,
		"--omp-md-link-url": p.muted,
		"--omp-md-code": p.inlineCode,
		"--omp-md-code-block": p.text,
		"--omp-md-code-block-border": p.border,
		"--omp-md-quote": p.textSecondary,
		"--omp-md-quote-border": mix(p.border, p.borderStrong, 0.4),
		"--omp-md-hr": p.borderMuted,
		"--omp-md-list-bullet": p.muted,
		"--omp-diff-added": p.success,
		"--omp-diff-added-bg": withAlpha(p.success, wash),
		"--omp-diff-removed": p.error,
		"--omp-diff-removed-bg": withAlpha(p.error, wash),
		"--omp-diff-context": p.muted,
		"--omp-syntax-comment": p.syntax.comment,
		"--omp-syntax-keyword": p.syntax.keyword,
		"--omp-syntax-function": p.syntax.function,
		"--omp-syntax-variable": p.syntax.variable,
		"--omp-syntax-string": p.syntax.string,
		"--omp-syntax-number": p.syntax.number,
		"--omp-syntax-type": p.syntax.type,
		"--omp-syntax-operator": p.syntax.operator,
		"--omp-syntax-punctuation": p.syntax.punctuation,
		"--omp-thinking-off": p.dim,
		"--omp-thinking-minimal": p.muted,
		"--omp-thinking-low": p.textSecondary,
		"--omp-thinking-medium": p.accent,
		"--omp-thinking-high": p.accentBright,
		"--omp-thinking-xhigh": p.text,
		"--omp-status-bg": p.sunken,
		"--omp-status-model": p.textSecondary,
		"--omp-status-path": p.muted,
		"--omp-status-git-clean": p.success,
		"--omp-status-git-dirty": p.warning,
		"--omp-status-context": p.textSecondary,
		"--omp-status-spend": p.textSecondary,
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": p.muted,
		"--omp-status-dim": p.dim,
		"--omp-status-text": p.text,
		"--omp-muted": p.muted,
		"--omp-dim": p.dim,
		"--omp-link": p.accent,
		"--omp-custom-msg-label": p.accent,
		"--omp-input-bg": dark ? p.secondary : p.elevated,
		"--omp-input-border": p.borderStrong,
		"--omp-input-focus-border": p.focusRing ?? p.accent,
		"--omp-input-glow": withAlpha(p.focusRing ?? p.accent, 0.22),
		"--omp-btn-primary-bg": p.accent,
		"--omp-btn-primary-text": p.onAccent,
		"--omp-btn-secondary-bg": p.tertiary,
		"--omp-btn-danger-bg": p.error,
		"--omp-btn-danger-text": p.onError,
		"--omp-badge-bg": p.tertiary,
		"--omp-badge-text": p.textSecondary,
		"--omp-badge-accent": p.accent,
		"--omp-overlay-bg": p.overlay,
		"--omp-modal-bg": p.elevated,
		"--omp-modal-border": p.border,
		"--omp-toast-bg": p.elevated,
		"--omp-toast-text": p.text,
		"--omp-toast-border": p.border,
		"--omp-progress-bg": p.tertiary,
		"--omp-progress-fill": p.accent,
		"--omp-sidebar-bg": p.sunken,
		"--omp-sidebar-item-hover": withAlpha(p.text, 0.05),
		"--omp-sidebar-item-active": withAlpha(p.text, 0.07),
		"--omp-selection-bg": withAlpha(p.accent, 0.24),
		"--omp-scrollbar-thumb": mix(p.bg, p.borderStrong, 0.6),
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-panel-bg": p.sunken,
		"--omp-panel-border": p.borderMuted,
		"--omp-panel-header": p.muted,
		"--omp-titlebar-bg": p.bg,
		"--omp-titlebar-text": p.text,
		"--omp-shadow-sm": dark ? `0 1px 2px rgba(${p.shadow}, 0.3)` : `0 1px 2px rgba(${p.shadow}, 0.06)`,
		"--omp-shadow-md": dark
			? `0 6px 20px rgba(${p.shadow}, 0.38), 0 1px 3px rgba(${p.shadow}, 0.3)`
			: `0 4px 14px rgba(${p.shadow}, 0.08), 0 1px 3px rgba(${p.shadow}, 0.05)`,
		"--omp-shadow-lg": dark
			? `0 24px 64px rgba(${p.shadow}, 0.55), 0 2px 8px rgba(${p.shadow}, 0.35)`
			: `0 18px 48px rgba(${p.shadow}, 0.16), 0 2px 8px rgba(${p.shadow}, 0.06)`,
	};
	return {
		label: p.label,
		description: p.description,
		scheme: p.scheme,
		origin: p.origin,
		tokens,
		ansi: ansiRow(p),
		chart: p.chart,
		focusRing: p.focusRing ?? p.accent,
	};
}
