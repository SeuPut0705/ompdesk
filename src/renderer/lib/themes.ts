/**
 * Named theme registry for the OMPdesk GUI.
 *
 * Every theme defines the exact same set of `--omp-*` design tokens (see
 * THEME_TOKEN_KEYS — the canonical 119 keys), the terminal's ANSI 16, six chart
 * series and a focus ring. `dark` and `light` (OMPdesk Dark / Light) are written
 * out below and match theme-dark.css / theme-light.css, where the same values are
 * spelled as `--sc-*` primitives plus `--omp-*` aliases (tokens.css);
 * styles/tokens.test.ts keeps the two in sync. Every other theme is a compact
 * palette (theme-palettes.ts) that theme-builder.ts expands. Transcript and ANSI
 * aliases in global.css follow these tokens in every palette.
 * applyThemeByName() writes the full token map as inline custom properties on
 * <html> (beating the `:root` stylesheet rules), mirrors it onto the `--sc-*`
 * palette (SC_TOKEN_SOURCES) so migrated surfaces follow named themes too,
 * keeps `data-theme` (scheme), `data-theme-name` (theme) and the color-scheme
 * meta in sync via lib/theme's applyTheme(), and persists the selection under
 * the `themeName` pref (plus the legacy `theme` pref for backwards compat).
 * "system" — the default — resolves the OS scheme to the theme the user paired
 * with it (`systemLightTheme` / `systemDarkTheme`).
 *
 * On top of the named themes sits the agent theme overlay (bottom of this
 * file): the coding-agent's `theme.dark` / `theme.light` settings name TUI
 * themes whose resolved colors are translated onto a subset of the same
 * tokens (see TRANSCRIPT_OVERLAY_VARS) and layered inline over the active GUI
 * theme, re-synced on config_update frames and data-theme flips.
 */

import type { RpcThemeColorsResult } from "../../shared/rpc-types";
import {
	DEFAULT_SYSTEM_THEMES,
	isThemeName,
	migrateThemeName,
	type SystemThemePair,
	systemThemeFor,
	type ThemeName,
	type ThemeScheme,
	type ThemeSelection,
} from "../../shared/theme-names";
import { saveGuiPreference } from "./display-preferences";
import { acceptsActiveTabEvents, onActiveTabRouteSettled, onActiveTabRouteState } from "./tab-routing";
import {
	applyTheme,
	markCustomThemeTokens,
	resolveTheme,
	THEME_PAINT_STORAGE_KEY,
	THEME_SCHEME_STORAGE_KEY,
	type ThemeMode,
} from "./theme";
import { ANSI_KEYS, ansiRow, buildTheme, CHART_KEYS } from "./theme-builder";
import {
	githubLight,
	gruvboxDark,
	highContrastDark,
	highContrastLight,
	nord as nordPalette,
	sepia,
	solarizedLight,
	tokyoNight,
} from "./theme-palettes";

/** Canonical token keys, in stylesheet order. Every theme defines all of them. */
export const THEME_TOKEN_KEYS = [
	"--omp-accent",
	"--omp-accent-bright",
	"--omp-accent-dim",
	"--omp-accent-glow",
	"--omp-border",
	"--omp-border-accent",
	"--omp-border-muted",
	"--omp-border-strong",
	"--omp-success",
	"--omp-success-dim",
	"--omp-error",
	"--omp-error-dim",
	"--omp-warning",
	"--omp-warning-dim",
	"--omp-info",
	"--omp-info-dim",
	"--omp-text",
	"--omp-text-secondary",
	"--omp-bg-primary",
	"--omp-bg-secondary",
	"--omp-bg-tertiary",
	"--omp-bg-elevated",
	"--omp-selected-bg",
	"--omp-user-msg-bg",
	"--omp-user-msg-border",
	"--omp-custom-msg-bg",
	"--omp-code-bg",
	"--omp-tool-pending-bg",
	"--omp-tool-error-bg",
	"--omp-tool-output",
	"--omp-tool-rail-running",
	"--omp-tool-rail-done",
	"--omp-tool-rail-error",
	"--omp-md-heading",
	"--omp-md-link",
	"--omp-md-link-url",
	"--omp-md-code",
	"--omp-md-code-block",
	"--omp-md-code-block-border",
	"--omp-md-quote",
	"--omp-md-quote-border",
	"--omp-md-hr",
	"--omp-md-list-bullet",
	"--omp-diff-added",
	"--omp-diff-added-bg",
	"--omp-diff-removed",
	"--omp-diff-removed-bg",
	"--omp-diff-context",
	"--omp-syntax-comment",
	"--omp-syntax-keyword",
	"--omp-syntax-function",
	"--omp-syntax-variable",
	"--omp-syntax-string",
	"--omp-syntax-number",
	"--omp-syntax-type",
	"--omp-syntax-operator",
	"--omp-syntax-punctuation",
	"--omp-thinking-off",
	"--omp-thinking-minimal",
	"--omp-thinking-low",
	"--omp-thinking-medium",
	"--omp-thinking-high",
	"--omp-thinking-xhigh",
	"--omp-status-bg",
	"--omp-status-model",
	"--omp-status-path",
	"--omp-status-git-clean",
	"--omp-status-git-dirty",
	"--omp-status-context",
	"--omp-status-spend",
	"--omp-status-subagents",
	"--omp-status-muted",
	"--omp-status-dim",
	"--omp-status-text",
	"--omp-muted",
	"--omp-dim",
	"--omp-link",
	"--omp-custom-msg-label",
	"--omp-input-bg",
	"--omp-input-border",
	"--omp-input-focus-border",
	"--omp-input-glow",
	"--omp-btn-primary-bg",
	"--omp-btn-primary-text",
	"--omp-btn-secondary-bg",
	"--omp-btn-danger-bg",
	"--omp-btn-danger-text",
	"--omp-badge-bg",
	"--omp-badge-text",
	"--omp-badge-accent",
	"--omp-overlay-bg",
	"--omp-modal-bg",
	"--omp-modal-border",
	"--omp-toast-bg",
	"--omp-toast-text",
	"--omp-toast-border",
	"--omp-progress-bg",
	"--omp-progress-fill",
	"--omp-sidebar-bg",
	"--omp-sidebar-item-hover",
	"--omp-sidebar-item-active",
	"--omp-selection-bg",
	"--omp-scrollbar-thumb",
	"--omp-scrollbar-track",
	"--omp-streaming-cursor",
	"--omp-panel-bg",
	"--omp-panel-border",
	"--omp-panel-header",
	"--omp-titlebar-bg",
	"--omp-titlebar-text",
	"--omp-shadow-sm",
	"--omp-shadow-md",
	"--omp-shadow-lg",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeTokens = Record<ThemeTokenKey, string>;

/**
 * The `--omp-*` token each `--sc-*` palette primitive takes its value from
 * when a named theme is applied. Derived washes (hover, selected, *-soft,
 * focus glow — tokens.css) follow from these through color-mix, so they are
 * not listed. `--sc-accent-fg` is picked for legibility (scTokensFor).
 */
export const SC_TOKEN_SOURCES = {
	"--sc-bg": "--omp-bg-primary",
	"--sc-surface-1": "--omp-sidebar-bg",
	"--sc-surface-2": "--omp-bg-secondary",
	"--sc-surface-3": "--omp-bg-tertiary",
	"--sc-elevated": "--omp-bg-elevated",
	"--sc-field": "--omp-input-bg",
	"--sc-overlay": "--omp-overlay-bg",
	"--sc-text": "--omp-text",
	"--sc-text-secondary": "--omp-text-secondary",
	"--sc-text-muted": "--omp-muted",
	"--sc-text-subtle": "--omp-dim",
	"--sc-divider": "--omp-border-muted",
	"--sc-border-subtle": "--omp-border",
	"--sc-border": "--omp-border-strong",
	"--sc-accent": "--omp-accent",
	"--sc-accent-hover": "--omp-accent-bright",
	"--sc-accent-fg": "--omp-btn-primary-text",
	"--sc-success": "--omp-success",
	"--sc-warning": "--omp-warning",
	"--sc-danger": "--omp-error",
	"--sc-danger-fg": "--omp-btn-danger-text",
	"--sc-info": "--omp-info",
	"--sc-shadow-sm": "--omp-shadow-sm",
	"--sc-shadow-md": "--omp-shadow-md",
	"--sc-shadow-lg": "--omp-shadow-lg",
} as const satisfies Record<`--sc-${string}`, ThemeTokenKey>;

export type ScTokenKey = keyof typeof SC_TOKEN_SOURCES;

export interface ThemeDefinition {
	/** Human-readable name shown in the picker. */
	label: string;
	/** One-line picker blurb. */
	description: string;
	/** Base color scheme — drives data-theme, the color-scheme meta, and native controls. */
	scheme: ThemeScheme;
	/** The published palette family this theme starts from, shown in the picker. */
	origin?: string;
	tokens: ThemeTokens;
	/** Terminal and ANSI-text colors: black…white, then the bright row (ANSI_KEYS order). */
	ansi: readonly string[];
	/** Categorical chart series (CHART_KEYS order). */
	chart: readonly string[];
	/** Keyboard focus ring. */
	focusRing: string;
}

const dark: ThemeDefinition = {
	label: "OMPdesk Dark",
	description: "Neutral charcoal with the OMPdesk indigo accent.",
	scheme: "dark",
	ansi: ansiRow({
		ansi: ["#8f8f99", "#f27a7d", "#5bc98c", "#e2b552", "#a5a7fa", "#f0a1bd", "#6cc7c0", "#c4c4cb"],
		text: "#ededf0",
	}),
	chart: ["#8b8df8", "#79a6f6", "#5bc98c", "#e2b552", "#f27a7d", "#a1a1aa"],
	focusRing: "#8b8df8",
	tokens: {
		"--omp-accent": "#8b8df8",
		"--omp-accent-bright": "#a1a3fa",
		"--omp-accent-dim": "rgba(139, 141, 248, 0.12)",
		"--omp-accent-glow": "rgba(139, 141, 248, 0.22)",
		"--omp-border": "#3a3a41",
		"--omp-border-accent": "rgba(139, 141, 248, 0.55)",
		"--omp-border-muted": "#2a2a30",
		"--omp-border-strong": "#6c6c76",
		"--omp-success": "#5bc98c",
		"--omp-success-dim": "rgba(91, 201, 140, 0.12)",
		"--omp-error": "#f27a7d",
		"--omp-error-dim": "rgba(242, 122, 125, 0.12)",
		"--omp-warning": "#e2b552",
		"--omp-warning-dim": "rgba(226, 181, 82, 0.12)",
		"--omp-info": "#79a6f6",
		"--omp-info-dim": "rgba(121, 166, 246, 0.12)",
		"--omp-text": "#ededf0",
		"--omp-text-secondary": "#c4c4cb",
		"--omp-bg-primary": "#19191c",
		"--omp-bg-secondary": "#1f1f23",
		"--omp-bg-tertiary": "#28282d",
		"--omp-bg-elevated": "#232327",
		"--omp-selected-bg": "rgba(237, 237, 240, 0.07)",
		"--omp-user-msg-bg": "#222226",
		"--omp-user-msg-border": "#3a3a41",
		"--omp-custom-msg-bg": "#1f1f23",
		"--omp-code-bg": "#141416",
		"--omp-tool-pending-bg": "#1f1f23",
		"--omp-tool-error-bg": "rgba(242, 122, 125, 0.07)",
		"--omp-tool-output": "#c4c4cb",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#5bc98c",
		"--omp-tool-rail-error": "#f27a7d",
		"--omp-md-heading": "#ededf0",
		"--omp-md-link": "#8b8df8",
		"--omp-md-link-url": "#a1a1aa",
		"--omp-md-code": "#f0a1bd",
		"--omp-md-code-block": "#ededf0",
		"--omp-md-code-block-border": "#3a3a41",
		"--omp-md-quote": "#c4c4cb",
		"--omp-md-quote-border": "#4a4a53",
		"--omp-md-hr": "#2a2a30",
		"--omp-md-list-bullet": "#a1a1aa",
		"--omp-diff-added": "#5bc98c",
		"--omp-diff-added-bg": "rgba(91, 201, 140, 0.12)",
		"--omp-diff-removed": "#f27a7d",
		"--omp-diff-removed-bg": "rgba(242, 122, 125, 0.12)",
		"--omp-diff-context": "#a1a1aa",
		"--omp-syntax-comment": "#8f8f99",
		"--omp-syntax-keyword": "#a5a7fa",
		"--omp-syntax-function": "#6cc7c0",
		"--omp-syntax-variable": "#ededf0",
		"--omp-syntax-string": "#e3b77a",
		"--omp-syntax-number": "#f0a1bd",
		"--omp-syntax-type": "#9fd39a",
		"--omp-syntax-operator": "#c4c4cb",
		"--omp-syntax-punctuation": "#a1a1aa",
		"--omp-thinking-off": "#8f8f99",
		"--omp-thinking-minimal": "#a1a1aa",
		"--omp-thinking-low": "#c4c4cb",
		"--omp-thinking-medium": "#8b8df8",
		"--omp-thinking-high": "#a1a3fa",
		"--omp-thinking-xhigh": "#ededf0",
		"--omp-status-bg": "#141416",
		"--omp-status-model": "#c4c4cb",
		"--omp-status-path": "#a1a1aa",
		"--omp-status-git-clean": "#5bc98c",
		"--omp-status-git-dirty": "#e2b552",
		"--omp-status-context": "#c4c4cb",
		"--omp-status-spend": "#c4c4cb",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#a1a1aa",
		"--omp-status-dim": "#8f8f99",
		"--omp-status-text": "#ededf0",
		"--omp-muted": "#a1a1aa",
		"--omp-dim": "#8f8f99",
		"--omp-link": "#8b8df8",
		"--omp-custom-msg-label": "#8b8df8",
		"--omp-input-bg": "#1f1f23",
		"--omp-input-border": "#6c6c76",
		"--omp-input-focus-border": "#8b8df8",
		"--omp-input-glow": "rgba(139, 141, 248, 0.22)",
		"--omp-btn-primary-bg": "#8b8df8",
		"--omp-btn-primary-text": "#0b0b1a",
		"--omp-btn-secondary-bg": "#28282d",
		"--omp-btn-danger-bg": "#f27a7d",
		"--omp-btn-danger-text": "#1c0a0b",
		"--omp-badge-bg": "#28282d",
		"--omp-badge-text": "#c4c4cb",
		"--omp-badge-accent": "#8b8df8",
		"--omp-overlay-bg": "rgba(0, 0, 0, 0.6)",
		"--omp-modal-bg": "#232327",
		"--omp-modal-border": "#3a3a41",
		"--omp-toast-bg": "#232327",
		"--omp-toast-text": "#ededf0",
		"--omp-toast-border": "#3a3a41",
		"--omp-progress-bg": "#28282d",
		"--omp-progress-fill": "#8b8df8",
		"--omp-sidebar-bg": "#141416",
		"--omp-sidebar-item-hover": "rgba(237, 237, 240, 0.05)",
		"--omp-sidebar-item-active": "rgba(237, 237, 240, 0.07)",
		"--omp-selection-bg": "rgba(139, 141, 248, 0.24)",
		"--omp-scrollbar-thumb": "#45454e",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-panel-bg": "#141416",
		"--omp-panel-border": "#2a2a30",
		"--omp-panel-header": "#a1a1aa",
		"--omp-titlebar-bg": "#19191c",
		"--omp-titlebar-text": "#ededf0",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.3)",
		"--omp-shadow-md": "0 6px 20px rgba(0, 0, 0, 0.38), 0 1px 3px rgba(0, 0, 0, 0.3)",
		"--omp-shadow-lg": "0 24px 64px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)",
	},
};

const light: ThemeDefinition = {
	label: "OMPdesk Light",
	description: "Clean white with the OMPdesk indigo accent.",
	scheme: "light",
	ansi: ansiRow({
		ansi: ["#6a6a73", "#bf3a3e", "#18794e", "#935f00", "#4646c0", "#a3365c", "#0f6b75", "#46464f"],
		text: "#1b1b1f",
	}),
	chart: ["#5b5bd6", "#2f62c4", "#18794e", "#935f00", "#bf3a3e", "#5f5f68"],
	focusRing: "#5b5bd6",
	tokens: {
		"--omp-accent": "#5b5bd6",
		"--omp-accent-bright": "#4f4fc4",
		"--omp-accent-dim": "rgba(91, 91, 214, 0.12)",
		"--omp-accent-glow": "rgba(91, 91, 214, 0.22)",
		"--omp-border": "#dcdce2",
		"--omp-border-accent": "rgba(91, 91, 214, 0.55)",
		"--omp-border-muted": "#ebebee",
		"--omp-border-strong": "#878790",
		"--omp-success": "#18794e",
		"--omp-success-dim": "rgba(24, 121, 78, 0.12)",
		"--omp-error": "#bf3a3e",
		"--omp-error-dim": "rgba(191, 58, 62, 0.12)",
		"--omp-warning": "#935f00",
		"--omp-warning-dim": "rgba(147, 95, 0, 0.12)",
		"--omp-info": "#2f62c4",
		"--omp-info-dim": "rgba(47, 98, 196, 0.12)",
		"--omp-text": "#1b1b1f",
		"--omp-text-secondary": "#46464f",
		"--omp-bg-primary": "#ffffff",
		"--omp-bg-secondary": "#f3f3f5",
		"--omp-bg-tertiary": "#ececef",
		"--omp-bg-elevated": "#ffffff",
		"--omp-selected-bg": "rgba(27, 27, 31, 0.07)",
		"--omp-user-msg-bg": "#f3f3f5",
		"--omp-user-msg-border": "#dcdce2",
		"--omp-custom-msg-bg": "#f3f3f5",
		"--omp-code-bg": "#f7f7f8",
		"--omp-tool-pending-bg": "#f3f3f5",
		"--omp-tool-error-bg": "rgba(191, 58, 62, 0.06)",
		"--omp-tool-output": "#46464f",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#18794e",
		"--omp-tool-rail-error": "#bf3a3e",
		"--omp-md-heading": "#1b1b1f",
		"--omp-md-link": "#5b5bd6",
		"--omp-md-link-url": "#5f5f68",
		"--omp-md-code": "#a3365c",
		"--omp-md-code-block": "#1b1b1f",
		"--omp-md-code-block-border": "#dcdce2",
		"--omp-md-quote": "#46464f",
		"--omp-md-quote-border": "#c9c9d1",
		"--omp-md-hr": "#ebebee",
		"--omp-md-list-bullet": "#5f5f68",
		"--omp-diff-added": "#18794e",
		"--omp-diff-added-bg": "rgba(24, 121, 78, 0.07)",
		"--omp-diff-removed": "#bf3a3e",
		"--omp-diff-removed-bg": "rgba(191, 58, 62, 0.06)",
		"--omp-diff-context": "#5f5f68",
		"--omp-syntax-comment": "#6a6a73",
		"--omp-syntax-keyword": "#4646c0",
		"--omp-syntax-function": "#0f6b75",
		"--omp-syntax-variable": "#1b1b1f",
		"--omp-syntax-string": "#865100",
		"--omp-syntax-number": "#a3365c",
		"--omp-syntax-type": "#2b6b3a",
		"--omp-syntax-operator": "#46464f",
		"--omp-syntax-punctuation": "#5f5f68",
		"--omp-thinking-off": "#6a6a73",
		"--omp-thinking-minimal": "#5f5f68",
		"--omp-thinking-low": "#46464f",
		"--omp-thinking-medium": "#5b5bd6",
		"--omp-thinking-high": "#4f4fc4",
		"--omp-thinking-xhigh": "#1b1b1f",
		"--omp-status-bg": "#f7f7f8",
		"--omp-status-model": "#46464f",
		"--omp-status-path": "#5f5f68",
		"--omp-status-git-clean": "#18794e",
		"--omp-status-git-dirty": "#935f00",
		"--omp-status-context": "#46464f",
		"--omp-status-spend": "#46464f",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#5f5f68",
		"--omp-status-dim": "#6a6a73",
		"--omp-status-text": "#1b1b1f",
		"--omp-muted": "#5f5f68",
		"--omp-dim": "#6a6a73",
		"--omp-link": "#5b5bd6",
		"--omp-custom-msg-label": "#5b5bd6",
		"--omp-input-bg": "#ffffff",
		"--omp-input-border": "#878790",
		"--omp-input-focus-border": "#5b5bd6",
		"--omp-input-glow": "rgba(91, 91, 214, 0.22)",
		"--omp-btn-primary-bg": "#5b5bd6",
		"--omp-btn-primary-text": "#ffffff",
		"--omp-btn-secondary-bg": "#ececef",
		"--omp-btn-danger-bg": "#bf3a3e",
		"--omp-btn-danger-text": "#ffffff",
		"--omp-badge-bg": "#ececef",
		"--omp-badge-text": "#46464f",
		"--omp-badge-accent": "#5b5bd6",
		"--omp-overlay-bg": "rgba(15, 15, 20, 0.32)",
		"--omp-modal-bg": "#ffffff",
		"--omp-modal-border": "#dcdce2",
		"--omp-toast-bg": "#ffffff",
		"--omp-toast-text": "#1b1b1f",
		"--omp-toast-border": "#dcdce2",
		"--omp-progress-bg": "#ececef",
		"--omp-progress-fill": "#5b5bd6",
		"--omp-sidebar-bg": "#f7f7f8",
		"--omp-sidebar-item-hover": "rgba(27, 27, 31, 0.05)",
		"--omp-sidebar-item-active": "rgba(27, 27, 31, 0.07)",
		"--omp-selection-bg": "rgba(91, 91, 214, 0.24)",
		"--omp-scrollbar-thumb": "#c6c6ce",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-panel-bg": "#f7f7f8",
		"--omp-panel-border": "#ebebee",
		"--omp-panel-header": "#5f5f68",
		"--omp-titlebar-bg": "#ffffff",
		"--omp-titlebar-text": "#1b1b1f",
		"--omp-shadow-sm": "0 1px 2px rgba(16, 16, 24, 0.06)",
		"--omp-shadow-md": "0 4px 14px rgba(16, 16, 24, 0.08), 0 1px 3px rgba(16, 16, 24, 0.05)",
		"--omp-shadow-lg": "0 18px 48px rgba(16, 16, 24, 0.16), 0 2px 8px rgba(16, 16, 24, 0.06)",
	},
};

const customThemes = {
	"github-light": buildTheme(githubLight),
	"solarized-light": buildTheme(solarizedLight),
	sepia: buildTheme(sepia),
	"hc-light": buildTheme(highContrastLight),
	nord: buildTheme(nordPalette),
	"tokyo-night": buildTheme(tokyoNight),
	"gruvbox-dark": buildTheme(gruvboxDark),
	"hc-dark": buildTheme(highContrastDark),
} as const;

/** Every theme by id, in picker order (the light group, then the dark group). */
export const THEMES = {
	light,
	"github-light": customThemes["github-light"],
	"solarized-light": customThemes["solarized-light"],
	sepia: customThemes.sepia,
	"hc-light": customThemes["hc-light"],
	dark,
	nord: customThemes.nord,
	"tokyo-night": customThemes["tokyo-night"],
	"gruvbox-dark": customThemes["gruvbox-dark"],
	"hc-dark": customThemes["hc-dark"],
} as const satisfies Record<ThemeName, ThemeDefinition>;

export type { SystemThemePair, ThemeName, ThemeSelection };

/** A stored value that is exactly a current theme id or "system". Stored prefs go through `migrateThemeName` instead. */
export function isThemeSelection(value: unknown): value is ThemeSelection {
	return value === "system" || isThemeName(value);
}

/** What System shows per OS scheme; set from the prefs at boot and by {@link setSystemThemePair}. */
let systemPair: SystemThemePair = { ...DEFAULT_SYSTEM_THEMES };
let currentSelection: ThemeSelection = "system";

export function getSystemThemePair(): SystemThemePair {
	return systemPair;
}

/** The id a selection shows right now ("system" resolves via the OS scheme and the System pair). */
export function resolveThemeName(selection: ThemeSelection): ThemeName {
	return selection === "system" ? systemPair[resolveTheme("system")] : selection;
}

/** The theme actually shown for a selection ("system" resolves via the OS and the System pair). */
export function resolveThemeSelection(selection: ThemeSelection): ThemeDefinition {
	return THEMES[resolveThemeName(selection)];
}

/**
 * Inline tokens most recently written by applyThemeByName. The agent theme
 * overlay (bottom of this file) restores these when an override goes away.
 */
let baseThemeTokens: ThemeTokens | null = null;
let themeSelectionVersion = 0;

export function getThemeSelectionVersion(): number {
	return themeSelectionVersion;
}

/** The page background of each OS scheme for the selection, which pre-paint.js paints before any script runs. */
function paintBackgrounds(selection: ThemeSelection): Partial<Record<ThemeScheme, string>> {
	if (selection === "system") {
		return {
			light: THEMES[systemPair.light].tokens["--omp-bg-primary"],
			dark: THEMES[systemPair.dark].tokens["--omp-bg-primary"],
		};
	}
	const theme = THEMES[selection];
	return { [theme.scheme]: theme.tokens["--omp-bg-primary"] };
}

/**
 * Applies a theme selection live: flips `data-theme` (the scheme) and
 * `data-theme-name` (the theme) on <html> plus the color-scheme meta, then
 * writes every token inline on <html>, with the terminal's ANSI 16, the chart
 * series and the focus ring. "system" shows the System pair's light or dark
 * theme for the OS scheme (lib/theme's watcher calls this again on OS changes).
 * Persists the selection under the `themeName` pref and mirrors the base
 * scheme (or "system") into the legacy `theme` pref so older boot paths stay
 * coherent. Pass `{ persist: false }` for ephemeral previews (settings-window
 * theme browsing, a focused host's theme) so the user's stored selection is
 * left untouched.
 */
export function applyThemeByName(selection: ThemeSelection, opts: { persist?: boolean } = {}): void {
	themeSelectionVersion++;
	currentSelection = selection;
	const { persist = true } = opts;
	const name = resolveThemeName(selection);
	const theme = THEMES[name];
	const mode = selection === "system" ? "system" : theme.scheme;
	applyTheme(mode);
	const root = document.documentElement;
	const style = root.style;
	for (const key of THEME_TOKEN_KEYS) style.setProperty(key, theme.tokens[key]);
	for (const [key, value] of Object.entries(scTokensFor(theme))) style.setProperty(key, value);
	for (const [key, value] of Object.entries(themeExtrasFor(theme))) style.setProperty(key, value);
	root.setAttribute("data-theme-name", name);
	baseThemeTokens = theme.tokens;
	markCustomThemeTokens(mode);
	writeOverlay();
	if (persist) {
		void saveGuiPreference("themeName", selection, () => {});
		void saveGuiPreference("theme", mode, () => {});
		storePaint(selection, mode);
	}
}

/** Mirror what pre-paint.js reads on the next cold start: the scheme (or "system") and each scheme's page background. */
function storePaint(selection: ThemeSelection, mode: ThemeMode): void {
	try {
		localStorage.setItem(THEME_SCHEME_STORAGE_KEY, mode);
		localStorage.setItem(THEME_PAINT_STORAGE_KEY, JSON.stringify(paintBackgrounds(selection)));
	} catch {
		// localStorage unavailable — the async path still applies the theme.
	}
}

/**
 * Chooses the light and dark theme System shows, then re-applies System when it is the
 * selection. A name of the wrong scheme falls back to the OMPdesk default of that scheme.
 * `persist: false` is for a host's pair shown without saving it.
 */
export function setSystemThemePair(next: Partial<SystemThemePair>, opts: { persist?: boolean } = {}): void {
	const { persist = true } = opts;
	systemPair = {
		light: systemThemeFor("light", next.light ?? systemPair.light),
		dark: systemThemeFor("dark", next.dark ?? systemPair.dark),
	};
	if (persist) {
		if (next.light !== undefined) void saveGuiPreference("systemLightTheme", systemPair.light, () => {});
		if (next.dark !== undefined) void saveGuiPreference("systemDarkTheme", systemPair.dark, () => {});
	}
	if (currentSelection === "system") applyThemeByName("system", { persist });
}

/**
 * Takes the System pair out of a prefs record (`systemLightTheme` / `systemDarkTheme`; the OMPdesk
 * defaults for what is unset or names a theme of the wrong scheme) as the live one. Boot calls it
 * before the first applyThemeByName.
 */
export function loadSystemThemePair(prefs: Readonly<Record<string, unknown>> | undefined): void {
	systemPair = {
		light: systemThemeFor("light", prefs?.systemLightTheme),
		dark: systemThemeFor("dark", prefs?.systemDarkTheme),
	};
}

/**
 * Reads the persisted selection: the `themeName` pref first, then the legacy
 * `theme` pref (dark/light/system written by older builds and the settings
 * window), falling back to "system" — OMPdesk follows the OS by default. A
 * retired theme id reads as its successor (shared/theme-names.ts); the first
 * read that finds one stores the successor, so the pref is never left naming
 * a theme the app no longer has.
 */
export async function getPersistedThemeSelection(prefs?: Readonly<Record<string, unknown>>): Promise<ThemeSelection> {
	if (prefs) {
		const named = migrateThemeName(prefs.themeName);
		if (named !== null) {
			if (typeof prefs.themeName === "string" && named !== prefs.themeName) {
				void saveGuiPreference("themeName", named, () => {});
			}
			return named;
		}
		return migrateThemeName(prefs.theme) ?? "system";
	}
	try {
		const stored = await window.omp.prefs.get("themeName");
		const named = migrateThemeName(stored);
		if (named !== null) {
			if (named !== stored) void saveGuiPreference("themeName", named, () => {});
			return named;
		}
		const legacy = migrateThemeName(await window.omp.prefs.get("theme"));
		if (legacy !== null) return legacy;
	} catch {
		// prefs IPC unavailable (tests, storybook) — use the default.
	}
	return "system";
}

/**
 * Resolves one level of `var(--omp-…)` indirection for swatch previews.
 * Values that are not a bare var() reference are returned unchanged.
 */
export function resolveTokenColor(theme: ThemeDefinition, key: ThemeTokenKey): string {
	const value = theme.tokens[key];
	const match = /^var\((--omp-[a-z-]+)\)$/.exec(value);
	if (!match) return value;
	return theme.tokens[match[1] as ThemeTokenKey] ?? value;
}

/** WCAG relative luminance of a `#rrggbb` / `#rgb` color; null for anything else. */
function hexLuminance(color: string): number | null {
	const raw = color.trim();
	const hex = /^#[0-9a-f]{3}$/i.test(raw)
		? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
		: /^#[0-9a-f]{6}$/i.test(raw)
			? raw
			: null;
	if (!hex) return null;
	return [0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
		const channel = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
		return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
	}, 0);
}

/**
 * The `--sc-*` palette a named theme implies (SC_TOKEN_SOURCES, one level of
 * var() resolved). Legacy themes paint primary buttons in ink, so their
 * `--omp-btn-primary-text` is not guaranteed to read on the accent: the
 * accent foreground is whichever of the primary-button pair contrasts more
 * with the accent.
 */
export function scTokensFor(theme: ThemeDefinition): Record<ScTokenKey, string> {
	const tokens = {} as Record<ScTokenKey, string>;
	for (const [key, source] of Object.entries(SC_TOKEN_SOURCES) as [ScTokenKey, ThemeTokenKey][]) {
		tokens[key] = resolveTokenColor(theme, source);
	}
	const accent = hexLuminance(tokens["--sc-accent"]);
	const ink = resolveTokenColor(theme, "--omp-btn-primary-text");
	const paper = resolveTokenColor(theme, "--omp-btn-primary-bg");
	const inkLum = hexLuminance(ink);
	const paperLum = hexLuminance(paper);
	if (accent !== null && inkLum !== null && paperLum !== null) {
		const ratio = (lum: number) => (Math.max(lum, accent) + 0.05) / (Math.min(lum, accent) + 0.05);
		tokens["--sc-accent-fg"] = ratio(paperLum) > ratio(inkLum) ? paper : ink;
	}
	return tokens;
}

/**
 * The custom properties a theme sets beyond THEME_TOKEN_KEYS: the terminal's ANSI 16 (`--omp-ansi-*`),
 * the chart series (`--omp-chart-1…6`) and the focus ring (`--sc-focus-ring`). global.css gives the
 * first two defaults taken from the semantic tokens, so a stylesheet-only first paint still reads.
 */
export function themeExtrasFor(theme: ThemeDefinition): Record<string, string> {
	const extras: Record<string, string> = { "--sc-focus-ring": theme.focusRing };
	ANSI_KEYS.forEach((key, index) => {
		extras[key] = theme.ansi[index] as string;
	});
	CHART_KEYS.forEach((key, index) => {
		extras[key] = theme.chart[index] as string;
	});
	return extras;
}

// ============================================================================
// Agent theme overlay (theme.dark / theme.light)
// ============================================================================

/**
 * TUI theme token → GUI `--omp-*` custom property. Only tokens with an exact
 * counterpart on both sides are mapped; everything else stays owned by the
 * active GUI named theme. TUI tokens deliberately left unmapped (no verified
 * GUI semantic — do not approximate):
 * - thinkingText, toolTitle, userMessageText, customMessageText: the GUI has
 *   no dedicated foreground tokens for these surfaces.
 * - thinkingMax: the GUI thinking ramp ends at --omp-thinking-xhigh.
 * - bashMode, pythonMode: TUI REPL prompt-mode accents with no GUI counterpart.
 * - statusLineStaged / statusLineDirty / statusLineUntracked /
 *   statusLineOutput / statusLineCost: TUI status-line counters the GUI
 *   footer does not tokenize.
 * - "link": an undeclared colors key some theme files carry; it is not part
 *   of the TUI theme schema (ThemeColor), so its role is unverifiable.
 *   mdLink already covers --omp-md-link.
 */
/**
 * TUI theme overlay may retint transcript internals only. Chrome tokens
 * (accent, sidebar, titlebar, buttons, inputs, status-line) stay with the
 * named GUI theme so the app identity cannot be swapped by sidecar themes.
 */
export const TRANSCRIPT_OVERLAY_VARS: Record<string, ThemeTokenKey> = {
	userMessageBg: "--omp-user-msg-bg",
	customMessageBg: "--omp-custom-msg-bg",
	customMessageLabel: "--omp-custom-msg-label",
	toolPendingBg: "--omp-tool-pending-bg",
	toolErrorBg: "--omp-tool-error-bg",
	toolOutput: "--omp-tool-output",
	mdHeading: "--omp-md-heading",
	mdLink: "--omp-md-link",
	mdLinkUrl: "--omp-md-link-url",
	mdCode: "--omp-md-code",
	mdCodeBlock: "--omp-md-code-block",
	mdCodeBlockBorder: "--omp-md-code-block-border",
	mdQuote: "--omp-md-quote",
	mdQuoteBorder: "--omp-md-quote-border",
	mdHr: "--omp-md-hr",
	mdListBullet: "--omp-md-list-bullet",
	toolDiffAdded: "--omp-diff-added",
	toolDiffRemoved: "--omp-diff-removed",
	toolDiffContext: "--omp-diff-context",
	syntaxComment: "--omp-syntax-comment",
	syntaxKeyword: "--omp-syntax-keyword",
	syntaxFunction: "--omp-syntax-function",
	syntaxVariable: "--omp-syntax-variable",
	syntaxString: "--omp-syntax-string",
	syntaxNumber: "--omp-syntax-number",
	syntaxType: "--omp-syntax-type",
	syntaxOperator: "--omp-syntax-operator",
	syntaxPunctuation: "--omp-syntax-punctuation",
	thinkingOff: "--omp-thinking-off",
	thinkingMinimal: "--omp-thinking-minimal",
	thinkingLow: "--omp-thinking-low",
	thinkingMedium: "--omp-thinking-medium",
	thinkingHigh: "--omp-thinking-high",
	thinkingXhigh: "--omp-thinking-xhigh",
};

const CHROME_OVERLAY_BLOCKLIST = new Set<ThemeTokenKey>([
	"--omp-accent",
	"--omp-sidebar-bg",
	"--omp-titlebar-bg",
	"--omp-btn-primary-bg",
]);

const AGENT_THEME_SETTING_PATHS = ["theme.dark", "theme.light"] as const;

/** Agent theme names keyed by GUI base scheme; null until the first settings sync lands. */
let agentThemeNames: { dark: string; light: string } | null = null;
/** CSS vars currently driven by the overlay (null = overlay inactive). */
let agentOverrides: Partial<Record<ThemeTokenKey, string>> | null = null;
/**
 * scheme:name of the last applied overlay. Combined with an intactness probe
 * so same-value data-theme refires (font-size changes, boot) skip re-fetching.
 */
let lastOverlaySignature: string | null = null;
/** Monotonic id — a slow get_theme_colors response must never clobber a newer overlay. */
let agentThemeRequestId = 0;
let agentThemeSettingsRequestId = 0;

/**
 * Fetches one agent theme's resolved colors from the sidecar and maps them
 * onto GUI tokens. Returns null when the theme can't be resolved (unknown
 * name, sidecar down) so callers fall back to the plain named theme.
 */
async function fetchAgentThemeOverrides(name: string): Promise<Partial<Record<ThemeTokenKey, string>> | null> {
	let colors: Record<string, string> | undefined;
	try {
		const res = await window.omp.rpc.getThemeColors(name);
		if (!res.success) return null;
		colors = (res.data as RpcThemeColorsResult | undefined)?.colors;
	} catch {
		return null;
	}
	if (!colors || typeof colors !== "object") return null;
	const overrides: Partial<Record<ThemeTokenKey, string>> = {};
	for (const [token, cssVar] of Object.entries(TRANSCRIPT_OVERLAY_VARS)) {
		if (CHROME_OVERLAY_BLOCKLIST.has(cssVar)) continue;
		const value = colors[token];
		if (typeof value === "string" && value !== "") overrides[cssVar] = value;
	}
	return overrides;
}

/** Currently applied plugin overlay (gui.theme tokens); null when inactive. */
let pluginOverrides: Partial<Record<ThemeTokenKey, string>> | null = null;
/** Combined inline vars last written by the overlay writer. */
let lastWrittenOverlay: Partial<Record<ThemeTokenKey, string>> | null = null;

/**
 * Single overlay writer: merges the plugin layer UNDER the agent layer
 * (agent wins on conflicts) and reconciles inline custom properties against
 * the previous write — vars no longer covered are restored to the named
 * theme's inline tokens (or dropped back to the stylesheet while the
 * "system" selection is stylesheet-driven).
 */
function writeOverlay(): void {
	const merged: Partial<Record<ThemeTokenKey, string>> | null =
		agentOverrides || pluginOverrides ? { ...pluginOverrides, ...agentOverrides } : null;
	const style = document.documentElement.style;
	if (lastWrittenOverlay) {
		for (const key of Object.keys(lastWrittenOverlay) as ThemeTokenKey[]) {
			if (merged && key in merged) continue;
			const base = baseThemeTokens?.[key];
			if (base !== undefined) style.setProperty(key, base);
			else style.removeProperty(key);
		}
	}
	if (merged) {
		for (const [key, value] of Object.entries(merged)) {
			if (typeof value === "string") style.setProperty(key, value);
		}
	}
	lastWrittenOverlay = merged;
}

function applyAgentOverrides(next: Partial<Record<ThemeTokenKey, string>> | null): void {
	agentOverrides = next;
	writeOverlay();
}

/**
 * True while every var of the combined overlay is still present inline WITH
 * the value this module last wrote. applyTheme() rewrites every inline token
 * with the new base theme's values on any named-theme switch — including
 * same-scheme switches that leave `lastOverlaySignature` untouched — so a
 * presence-only probe missed the wipe and the overlay stayed lost.
 */
function overlayIntact(): boolean {
	if (!lastWrittenOverlay) return true;
	const style = document.documentElement.style;
	for (const [key, expected] of Object.entries(lastWrittenOverlay) as [ThemeTokenKey, string][]) {
		if (style.getPropertyValue(key).trim() !== expected.trim()) return false;
	}
	return true;
}

// ============================================================================
// Plugin theme overlay (manifest gui.theme tokens)
// ============================================================================

/**
 * Accepted gui.theme value shapes, anchored at both ends so trailing garbage
 * is rejected rather than truncated: hex (#rgb/#rgba/#rrggbb/#rrggbbaa only —
 * 5/7-digit runs are invalid CSS), functional colors with one level of paren
 * nesting (rgb()/hsl()/oklch()/…/color-mix(in oklch, oklch(…), …)), or a
 * var() reference to an existing --omp-* token. Named colors (red, …) are
 * deliberately excluded — the shapes above are the auditable surface.
 */
const PLUGIN_THEME_VALUE_RE =
	/^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix|color)\((?:[^()]|\([^()]*\))*\)|var\(--[a-zA-Z0-9-]+\))$/;

export interface ValidatedPluginTheme {
	tokens: Partial<Record<ThemeTokenKey, string>>;
	rejected: string[];
}

/**
 * Validates one plugin's gui.theme token map against the transcript overlay
 * allowlist (chrome stays host-owned by construction — the overlay map has no
 * chrome entries) and a CSS color-value shape. Unknown keys and non-color
 * values are rejected individually so one bad token cannot sink the theme.
 */
export function validatePluginThemeTokens(tokens: Record<string, unknown>): ValidatedPluginTheme {
	const validated: ValidatedPluginTheme = { tokens: {}, rejected: [] };
	for (const [key, value] of Object.entries(tokens)) {
		const cssVar = TRANSCRIPT_OVERLAY_VARS[key];
		if (cssVar === undefined || CHROME_OVERLAY_BLOCKLIST.has(cssVar)) {
			validated.rejected.push(key);
			continue;
		}
		const trimmed = typeof value === "string" ? value.trim() : "";
		if (!PLUGIN_THEME_VALUE_RE.test(trimmed) || (typeof CSS !== "undefined" && !CSS.supports("color", trimmed))) {
			validated.rejected.push(key);
			continue;
		}
		validated.tokens[cssVar] = trimmed;
	}
	return validated;
}

/**
 * Layers validated plugin theme tokens under the agent overlay and rewrites
 * the combined inline vars. null clears the plugin layer. Returns the
 * rejected key names so callers can surface them.
 */
export function applyPluginThemeOverlay(tokens: Record<string, unknown> | null): string[] {
	if (!tokens) {
		pluginOverrides = null;
		writeOverlay();
		return [];
	}
	const { tokens: validated, rejected } = validatePluginThemeTokens(tokens);
	pluginOverrides = Object.keys(validated).length > 0 ? validated : null;
	writeOverlay();
	return rejected;
}

/**
 * Fetches gui.theme tokens from every enabled plugin and applies their
 * merge. Called at App boot, after activation restarts, and on route
 * changes; plugin changes that skip the restart pick the new state up on
 * the next refresh. Generation-guarded: a slower older response must never
 * overwrite a newer enabled-plugin set.
 */
let pluginThemeRequestId = 0;

export function clearPluginThemes(): void {
	pluginThemeRequestId++;
	applyPluginThemeOverlay(null);
}

export async function refreshPluginThemes(): Promise<void> {
	if (!acceptsActiveTabEvents()) return;
	const requestId = ++pluginThemeRequestId;
	let merged: Record<string, string> | null = null;
	try {
		const res = await window.omp.rpc.getGuiThemes();
		if (requestId !== pluginThemeRequestId) return;
		if (res.success) {
			const data = res.data as { themes?: Array<{ tokens: Record<string, string> }> } | undefined;
			for (const theme of data?.themes ?? []) {
				merged = Object.assign(merged ?? {}, theme.tokens);
			}
		} else {
			// Backend refused (sidecar starting, transient read error): keep the
			// currently applied overlay instead of clearing every plugin color.
			return;
		}
	} catch {
		return; // sidecar down — keep whatever is already applied
	}
	if (requestId !== pluginThemeRequestId || !acceptsActiveTabEvents()) return;
	applyPluginThemeOverlay(merged);
}

/**
 * Resolves which agent theme (if any) applies to the current GUI base scheme
 * and re-layers it. No-ops until data-theme exists — the App boot effects set
 * it synchronously and the MutationObserver re-fires once they do.
 */
async function refreshAgentThemeOverrides(): Promise<void> {
	if (!acceptsActiveTabEvents()) return;
	const attr = document.documentElement.getAttribute("data-theme");
	if (attr !== "dark" && attr !== "light") return;
	const name = agentThemeNames?.[attr] ?? "";
	if (name === "") {
		agentThemeRequestId++;
		lastOverlaySignature = null;
		applyAgentOverrides(null);
		return;
	}
	const signature = `${attr}:${name}`;
	if (signature === lastOverlaySignature && overlayIntact()) return;
	const requestId = ++agentThemeRequestId;
	const overrides = await fetchAgentThemeOverrides(name);
	if (requestId !== agentThemeRequestId || !acceptsActiveTabEvents()) return;
	lastOverlaySignature = overrides ? signature : null;
	applyAgentOverrides(overrides);
}

/** Reads theme.dark / theme.light from the agent and forces a re-layer. */
async function syncAgentThemeSettings(): Promise<void> {
	if (!acceptsActiveTabEvents()) return;
	const requestId = ++agentThemeSettingsRequestId;
	try {
		const res = await window.omp.rpc.getSettings([...AGENT_THEME_SETTING_PATHS]);
		if (requestId !== agentThemeSettingsRequestId || !acceptsActiveTabEvents()) return;
		const values = res.success ? (res.data as { values?: Record<string, unknown> } | undefined)?.values : undefined;
		const dark = values?.["theme.dark"];
		const light = values?.["theme.light"];
		agentThemeNames = {
			dark: typeof dark === "string" ? dark : "",
			light: typeof light === "string" ? light : "",
		};
	} catch {
		if (requestId !== agentThemeSettingsRequestId || !acceptsActiveTabEvents()) return;
		agentThemeNames = null;
	}
	lastOverlaySignature = null;
	await refreshAgentThemeOverrides();
}

/**
 * Starts layering the agent's theme.dark / theme.light TUI themes on top of
 * the active GUI theme: the theme matching the GUI's current base scheme
 * (theme.dark while data-theme is dark, theme.light while light) is resolved
 * into inline CSS var overrides over the GUI named theme, re-applied on every
 * config_update frame and on every GUI theme/scheme change (observed via
 * data-theme). Unset or unresolvable agent themes leave the GUI named theme
 * untouched. Call once at App boot; the returned teardown restores the base.
 */
export function initAgentThemeSync(): () => void {
	void syncAgentThemeSettings();
	const unsubscribe = window.omp.events.onConfigUpdate(() => {
		if (acceptsActiveTabEvents()) void syncAgentThemeSettings();
	});
	const unsubscribeRoute = onActiveTabRouteSettled(() => void syncAgentThemeSettings());
	const resetOverlay = () => {
		agentThemeRequestId++;
		agentThemeSettingsRequestId++;
		agentThemeNames = null;
		lastOverlaySignature = null;
		applyAgentOverrides(null);
	};
	const unsubscribeRouting = onActiveTabRouteState(ready => {
		if (!ready) resetOverlay();
	});
	const observer = new MutationObserver(() => {
		void refreshAgentThemeOverrides();
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => {
		unsubscribe();
		unsubscribeRoute();
		unsubscribeRouting();
		observer.disconnect();
		resetOverlay();
	};
}
