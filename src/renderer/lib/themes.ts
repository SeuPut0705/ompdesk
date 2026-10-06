/**
 * Named theme registry for the seucode GUI.
 *
 * Every theme defines the exact same set of `--omp-*` design tokens (see
 * THEME_TOKEN_KEYS — the canonical 119 keys). `dark` and `light` are the
 * seucode default palettes and match theme-dark.css / theme-light.css, where
 * the same values are spelled as `--sc-*` primitives plus `--omp-*` aliases
 * (tokens.css); styles/tokens.test.ts keeps the two in sync. Transcript and
 * ANSI aliases in global.css follow these tokens in every palette.
 * applyThemeByName() writes the full token map as inline custom properties on
 * <html> (beating the `:root` stylesheet rules), mirrors it onto the `--sc-*`
 * palette (SC_TOKEN_SOURCES) so migrated surfaces follow named themes too,
 * keeps `data-theme` / the color-scheme meta in sync via lib/theme's
 * applyTheme(), and persists the selection under the `themeName` pref (plus
 * the legacy `theme` pref for backwards compat). "system" — the default — is
 * a special selection that resolves to dark or light via the OS media query
 * and stays stylesheet-driven.
 *
 * On top of the named themes sits the agent theme overlay (bottom of this
 * file): the coding-agent's `theme.dark` / `theme.light` settings name TUI
 * themes whose resolved colors are translated onto a subset of the same
 * tokens (see TRANSCRIPT_OVERLAY_VARS) and layered inline over the active GUI
 * theme, re-synced on config_update frames and data-theme flips.
 */

import type { RpcThemeColorsResult } from "../../shared/rpc-types";
import { saveGuiPreference } from "./display-preferences";
import { acceptsActiveTabEvents, onActiveTabRouteSettled, onActiveTabRouteState } from "./tab-routing";
import { applyTheme, markCustomThemeTokens, resolveTheme, THEME_SCHEME_STORAGE_KEY } from "./theme";

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
	"--omp-tool-success-bg",
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
	"--omp-status-sep",
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
	"--omp-btn-secondary-text",
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
	"--omp-selection-text",
	"--omp-scrollbar-thumb",
	"--omp-scrollbar-track",
	"--omp-streaming-cursor",
	"--omp-streaming-highlight",
	"--omp-panel-bg",
	"--omp-panel-border",
	"--omp-panel-header",
	"--omp-titlebar-bg",
	"--omp-titlebar-text",
	"--omp-shadow-sm",
	"--omp-shadow-md",
	"--omp-shadow-lg",
	"--omp-shadow-glow",
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
	scheme: "dark" | "light";
	tokens: ThemeTokens;
}

const dark: ThemeDefinition = {
	label: "Graphite",
	description: "The seucode dark default: neutral charcoal and an indigo accent.",
	scheme: "dark",
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
		"--omp-tool-success-bg": "rgba(91, 201, 140, 0.06)",
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
		"--omp-status-sep": "#2a2a30",
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
		"--omp-btn-secondary-text": "#ededf0",
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
		"--omp-selection-text": "#ededf0",
		"--omp-scrollbar-thumb": "#45454e",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(139, 141, 248, 0.06)",
		"--omp-panel-bg": "#141416",
		"--omp-panel-border": "#2a2a30",
		"--omp-panel-header": "#a1a1aa",
		"--omp-titlebar-bg": "#19191c",
		"--omp-titlebar-text": "#ededf0",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.3)",
		"--omp-shadow-md": "0 6px 20px rgba(0, 0, 0, 0.38), 0 1px 3px rgba(0, 0, 0, 0.3)",
		"--omp-shadow-lg": "0 24px 64px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const light: ThemeDefinition = {
	label: "Porcelain",
	description: "The seucode light default: clean white and an indigo accent.",
	scheme: "light",
	tokens: {
		"--omp-accent": "#5b5bd6",
		"--omp-accent-bright": "#4f4fc4",
		"--omp-accent-dim": "rgba(91, 91, 214, 0.12)",
		"--omp-accent-glow": "rgba(91, 91, 214, 0.22)",
		"--omp-border": "#dcdce2",
		"--omp-border-accent": "rgba(91, 91, 214, 0.55)",
		"--omp-border-muted": "#ebebee",
		"--omp-border-strong": "#8d8d96",
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
		"--omp-tool-success-bg": "rgba(24, 121, 78, 0.05)",
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
		"--omp-status-sep": "#ebebee",
		"--omp-muted": "#5f5f68",
		"--omp-dim": "#6a6a73",
		"--omp-link": "#5b5bd6",
		"--omp-custom-msg-label": "#5b5bd6",
		"--omp-input-bg": "#ffffff",
		"--omp-input-border": "#8d8d96",
		"--omp-input-focus-border": "#5b5bd6",
		"--omp-input-glow": "rgba(91, 91, 214, 0.22)",
		"--omp-btn-primary-bg": "#5b5bd6",
		"--omp-btn-primary-text": "#ffffff",
		"--omp-btn-secondary-bg": "#ececef",
		"--omp-btn-secondary-text": "#1b1b1f",
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
		"--omp-selection-text": "#1b1b1f",
		"--omp-scrollbar-thumb": "#c6c6ce",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(91, 91, 214, 0.05)",
		"--omp-panel-bg": "#f7f7f8",
		"--omp-panel-border": "#ebebee",
		"--omp-panel-header": "#5f5f68",
		"--omp-titlebar-bg": "#ffffff",
		"--omp-titlebar-text": "#1b1b1f",
		"--omp-shadow-sm": "0 1px 2px rgba(16, 16, 24, 0.06)",
		"--omp-shadow-md": "0 4px 14px rgba(16, 16, 24, 0.08), 0 1px 3px rgba(16, 16, 24, 0.05)",
		"--omp-shadow-lg": "0 18px 48px rgba(16, 16, 24, 0.16), 0 2px 8px rgba(16, 16, 24, 0.06)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const titanium: ThemeDefinition = {
	label: "Slate",
	description: "Soft slate surfaces and silver-blue details.",
	scheme: "dark",
	tokens: {
		"--omp-accent": "#accad6",
		"--omp-accent-bright": "#c9e0e7",
		"--omp-accent-dim": "rgba(172, 202, 214, 0.13)",
		"--omp-accent-glow": "rgba(172, 202, 214, 0.16)",
		"--omp-border": "#414b53",
		"--omp-border-accent": "rgba(172, 202, 214, 0.52)",
		"--omp-border-muted": "#343d45",
		"--omp-border-strong": "#687680",
		"--omp-success": "#9bc7ab",
		"--omp-success-dim": "rgba(155, 199, 171, 0.08)",
		"--omp-error": "#e6a09a",
		"--omp-error-dim": "rgba(230, 160, 154, 0.08)",
		"--omp-warning": "#d7bc88",
		"--omp-warning-dim": "rgba(215, 188, 136, 0.08)",
		"--omp-info": "#a2bfdc",
		"--omp-info-dim": "rgba(162, 191, 220, 0.08)",
		"--omp-text": "#edf0f1",
		"--omp-text-secondary": "#c7cfd4",
		"--omp-bg-primary": "#24282c",
		"--omp-bg-secondary": "#2b3035",
		"--omp-bg-tertiary": "#343b41",
		"--omp-bg-elevated": "#383f46",
		"--omp-selected-bg": "rgba(172, 202, 214, 0.12)",
		"--omp-user-msg-bg": "#2b3035",
		"--omp-user-msg-border": "#414b53",
		"--omp-custom-msg-bg": "#2b3035",
		"--omp-code-bg": "#2b3035",
		"--omp-tool-pending-bg": "#2b3035",
		"--omp-tool-success-bg": "rgba(155, 199, 171, 0.045)",
		"--omp-tool-error-bg": "rgba(230, 160, 154, 0.065)",
		"--omp-tool-output": "#c7cfd4",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#9bc7ab",
		"--omp-tool-rail-error": "#e6a09a",
		"--omp-md-heading": "#edf0f1",
		"--omp-md-link": "#accad6",
		"--omp-md-link-url": "#b4bfc6",
		"--omp-md-code": "#deb0a1",
		"--omp-md-code-block": "#edf0f1",
		"--omp-md-code-block-border": "#414b53",
		"--omp-md-quote": "#c7cfd4",
		"--omp-md-quote-border": "#687680",
		"--omp-md-hr": "#414b53",
		"--omp-md-list-bullet": "#b4bfc6",
		"--omp-diff-added": "#9bc7ab",
		"--omp-diff-added-bg": "rgba(155, 199, 171, 0.09)",
		"--omp-diff-removed": "#e6a09a",
		"--omp-diff-removed-bg": "rgba(230, 160, 154, 0.09)",
		"--omp-diff-context": "#b4bfc6",
		"--omp-syntax-comment": "#a5b2bc",
		"--omp-syntax-keyword": "#a3bedb",
		"--omp-syntax-function": "#91c5bf",
		"--omp-syntax-variable": "#edf0f1",
		"--omp-syntax-string": "#d4ba91",
		"--omp-syntax-number": "#deb0a1",
		"--omp-syntax-type": "#b9cdb1",
		"--omp-syntax-operator": "#c7cfd4",
		"--omp-syntax-punctuation": "#b4bfc6",
		"--omp-thinking-off": "#a5b2bc",
		"--omp-thinking-minimal": "#b4bfc6",
		"--omp-thinking-low": "#c7cfd4",
		"--omp-thinking-medium": "#accad6",
		"--omp-thinking-high": "#c9e0e7",
		"--omp-thinking-xhigh": "#edf0f1",
		"--omp-status-bg": "#1d2125",
		"--omp-status-model": "#c7cfd4",
		"--omp-status-path": "#b4bfc6",
		"--omp-status-git-clean": "#9bc7ab",
		"--omp-status-git-dirty": "#d7bc88",
		"--omp-status-context": "#c7cfd4",
		"--omp-status-spend": "#c7cfd4",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#b4bfc6",
		"--omp-status-dim": "#a5b2bc",
		"--omp-status-text": "#edf0f1",
		"--omp-status-sep": "#414b53",
		"--omp-muted": "#b4bfc6",
		"--omp-dim": "#a5b2bc",
		"--omp-link": "#accad6",
		"--omp-custom-msg-label": "#accad6",
		"--omp-input-bg": "#2b3035",
		"--omp-input-border": "#414b53",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(172, 202, 214, 0.1)",
		"--omp-btn-primary-bg": "#edf0f1",
		"--omp-btn-primary-text": "#24282c",
		"--omp-btn-secondary-bg": "#343b41",
		"--omp-btn-secondary-text": "#edf0f1",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#24282c",
		"--omp-badge-bg": "#343b41",
		"--omp-badge-text": "#c7cfd4",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(8, 12, 16, 0.62)",
		"--omp-modal-bg": "#383f46",
		"--omp-modal-border": "#414b53",
		"--omp-toast-bg": "#383f46",
		"--omp-toast-text": "#edf0f1",
		"--omp-toast-border": "#414b53",
		"--omp-progress-bg": "#343b41",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#1d2125",
		"--omp-sidebar-item-hover": "#343b41",
		"--omp-sidebar-item-active": "rgba(172, 202, 214, 0.13)",
		"--omp-selection-bg": "rgba(172, 202, 214, 0.25)",
		"--omp-selection-text": "#edf0f1",
		"--omp-scrollbar-thumb": "#687680",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(172, 202, 214, 0.04)",
		"--omp-panel-bg": "#1d2125",
		"--omp-panel-border": "#343d45",
		"--omp-panel-header": "#b4bfc6",
		"--omp-titlebar-bg": "#1d2125",
		"--omp-titlebar-text": "#edf0f1",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.16)",
		"--omp-shadow-md": "0 6px 18px rgba(0, 0, 0, 0.22)",
		"--omp-shadow-lg": "0 16px 48px rgba(0, 0, 0, 0.32)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const nord: ThemeDefinition = {
	label: "Deep Sea",
	description: "Deep petrol blue with a soft sea-glass accent.",
	scheme: "dark",
	tokens: {
		"--omp-accent": "#8bc4c5",
		"--omp-accent-bright": "#b3dcdc",
		"--omp-accent-dim": "rgba(139, 196, 197, 0.13)",
		"--omp-accent-glow": "rgba(139, 196, 197, 0.16)",
		"--omp-border": "#324c58",
		"--omp-border-accent": "rgba(139, 196, 197, 0.52)",
		"--omp-border-muted": "#263e49",
		"--omp-border-strong": "#587984",
		"--omp-success": "#9bc7ab",
		"--omp-success-dim": "rgba(155, 199, 171, 0.08)",
		"--omp-error": "#e6a09a",
		"--omp-error-dim": "rgba(230, 160, 154, 0.08)",
		"--omp-warning": "#d7bc88",
		"--omp-warning-dim": "rgba(215, 188, 136, 0.08)",
		"--omp-info": "#a2bfdc",
		"--omp-info-dim": "rgba(162, 191, 220, 0.08)",
		"--omp-text": "#e3edef",
		"--omp-text-secondary": "#b7cbd2",
		"--omp-bg-primary": "#14232b",
		"--omp-bg-secondary": "#192c35",
		"--omp-bg-tertiary": "#223a44",
		"--omp-bg-elevated": "#29414c",
		"--omp-selected-bg": "rgba(139, 196, 197, 0.12)",
		"--omp-user-msg-bg": "#192c35",
		"--omp-user-msg-border": "#324c58",
		"--omp-custom-msg-bg": "#192c35",
		"--omp-code-bg": "#192c35",
		"--omp-tool-pending-bg": "#192c35",
		"--omp-tool-success-bg": "rgba(155, 199, 171, 0.045)",
		"--omp-tool-error-bg": "rgba(230, 160, 154, 0.065)",
		"--omp-tool-output": "#b7cbd2",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#9bc7ab",
		"--omp-tool-rail-error": "#e6a09a",
		"--omp-md-heading": "#e3edef",
		"--omp-md-link": "#8bc4c5",
		"--omp-md-link-url": "#a5bec7",
		"--omp-md-code": "#deb0a1",
		"--omp-md-code-block": "#e3edef",
		"--omp-md-code-block-border": "#324c58",
		"--omp-md-quote": "#b7cbd2",
		"--omp-md-quote-border": "#587984",
		"--omp-md-hr": "#324c58",
		"--omp-md-list-bullet": "#a5bec7",
		"--omp-diff-added": "#9bc7ab",
		"--omp-diff-added-bg": "rgba(155, 199, 171, 0.09)",
		"--omp-diff-removed": "#e6a09a",
		"--omp-diff-removed-bg": "rgba(230, 160, 154, 0.09)",
		"--omp-diff-context": "#a5bec7",
		"--omp-syntax-comment": "#98b2bf",
		"--omp-syntax-keyword": "#a3bedb",
		"--omp-syntax-function": "#91c5bf",
		"--omp-syntax-variable": "#e3edef",
		"--omp-syntax-string": "#d4ba91",
		"--omp-syntax-number": "#deb0a1",
		"--omp-syntax-type": "#b9cdb1",
		"--omp-syntax-operator": "#b7cbd2",
		"--omp-syntax-punctuation": "#a5bec7",
		"--omp-thinking-off": "#98b2bf",
		"--omp-thinking-minimal": "#a5bec7",
		"--omp-thinking-low": "#b7cbd2",
		"--omp-thinking-medium": "#8bc4c5",
		"--omp-thinking-high": "#b3dcdc",
		"--omp-thinking-xhigh": "#e3edef",
		"--omp-status-bg": "#101d24",
		"--omp-status-model": "#b7cbd2",
		"--omp-status-path": "#a5bec7",
		"--omp-status-git-clean": "#9bc7ab",
		"--omp-status-git-dirty": "#d7bc88",
		"--omp-status-context": "#b7cbd2",
		"--omp-status-spend": "#b7cbd2",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#a5bec7",
		"--omp-status-dim": "#98b2bf",
		"--omp-status-text": "#e3edef",
		"--omp-status-sep": "#324c58",
		"--omp-muted": "#a5bec7",
		"--omp-dim": "#98b2bf",
		"--omp-link": "#8bc4c5",
		"--omp-custom-msg-label": "#8bc4c5",
		"--omp-input-bg": "#192c35",
		"--omp-input-border": "#324c58",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(139, 196, 197, 0.1)",
		"--omp-btn-primary-bg": "#e3edef",
		"--omp-btn-primary-text": "#14232b",
		"--omp-btn-secondary-bg": "#223a44",
		"--omp-btn-secondary-text": "#e3edef",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#14232b",
		"--omp-badge-bg": "#223a44",
		"--omp-badge-text": "#b7cbd2",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(8, 12, 16, 0.62)",
		"--omp-modal-bg": "#29414c",
		"--omp-modal-border": "#324c58",
		"--omp-toast-bg": "#29414c",
		"--omp-toast-text": "#e3edef",
		"--omp-toast-border": "#324c58",
		"--omp-progress-bg": "#223a44",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#101d24",
		"--omp-sidebar-item-hover": "#223a44",
		"--omp-sidebar-item-active": "rgba(139, 196, 197, 0.13)",
		"--omp-selection-bg": "rgba(139, 196, 197, 0.25)",
		"--omp-selection-text": "#e3edef",
		"--omp-scrollbar-thumb": "#587984",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(139, 196, 197, 0.04)",
		"--omp-panel-bg": "#101d24",
		"--omp-panel-border": "#263e49",
		"--omp-panel-header": "#a5bec7",
		"--omp-titlebar-bg": "#101d24",
		"--omp-titlebar-text": "#e3edef",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.16)",
		"--omp-shadow-md": "0 6px 18px rgba(0, 0, 0, 0.22)",
		"--omp-shadow-lg": "0 16px 48px rgba(0, 0, 0, 0.32)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const solarized: ThemeDefinition = {
	label: "Sand",
	description: "Pale sand, warm stone, and a muted ochre accent.",
	scheme: "light",
	tokens: {
		"--omp-accent": "#825d2a",
		"--omp-accent-bright": "#724c21",
		"--omp-accent-dim": "rgba(134, 97, 45, 0.08)",
		"--omp-accent-glow": "rgba(134, 97, 45, 0.16)",
		"--omp-border": "#ded7ca",
		"--omp-border-accent": "rgba(134, 97, 45, 0.52)",
		"--omp-border-muted": "#e9e3d9",
		"--omp-border-strong": "#b4a68e",
		"--omp-success": "#326747",
		"--omp-success-dim": "rgba(50, 103, 71, 0.08)",
		"--omp-error": "#9f4545",
		"--omp-error-dim": "rgba(159, 69, 69, 0.08)",
		"--omp-warning": "#80601e",
		"--omp-warning-dim": "rgba(128, 96, 30, 0.08)",
		"--omp-info": "#315f83",
		"--omp-info-dim": "rgba(49, 95, 131, 0.08)",
		"--omp-text": "#302e29",
		"--omp-text-secondary": "#5b574e",
		"--omp-bg-primary": "#faf8f3",
		"--omp-bg-secondary": "#f2efe7",
		"--omp-bg-tertiary": "#e8e3d8",
		"--omp-bg-elevated": "#fffdf9",
		"--omp-selected-bg": "rgba(134, 97, 45, 0.09)",
		"--omp-user-msg-bg": "#f2efe7",
		"--omp-user-msg-border": "#ded7ca",
		"--omp-custom-msg-bg": "#f2efe7",
		"--omp-code-bg": "#f2efe7",
		"--omp-tool-pending-bg": "#f2efe7",
		"--omp-tool-success-bg": "rgba(50, 103, 71, 0.045)",
		"--omp-tool-error-bg": "rgba(159, 69, 69, 0.065)",
		"--omp-tool-output": "#5b574e",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#326747",
		"--omp-tool-rail-error": "#9f4545",
		"--omp-md-heading": "#302e29",
		"--omp-md-link": "#825d2a",
		"--omp-md-link-url": "#686052",
		"--omp-md-code": "#944c42",
		"--omp-md-code-block": "#302e29",
		"--omp-md-code-block-border": "#ded7ca",
		"--omp-md-quote": "#5b574e",
		"--omp-md-quote-border": "#b4a68e",
		"--omp-md-hr": "#ded7ca",
		"--omp-md-list-bullet": "#686052",
		"--omp-diff-added": "#326747",
		"--omp-diff-added-bg": "rgba(50, 103, 71, 0.07)",
		"--omp-diff-removed": "#9f4545",
		"--omp-diff-removed-bg": "rgba(159, 69, 69, 0.07)",
		"--omp-diff-context": "#686052",
		"--omp-syntax-comment": "#6c6254",
		"--omp-syntax-keyword": "#315f83",
		"--omp-syntax-function": "#2b655f",
		"--omp-syntax-variable": "#302e29",
		"--omp-syntax-string": "#805c2e",
		"--omp-syntax-number": "#944c42",
		"--omp-syntax-type": "#516939",
		"--omp-syntax-operator": "#5b574e",
		"--omp-syntax-punctuation": "#686052",
		"--omp-thinking-off": "#6c6254",
		"--omp-thinking-minimal": "#686052",
		"--omp-thinking-low": "#5b574e",
		"--omp-thinking-medium": "#825d2a",
		"--omp-thinking-high": "#724c21",
		"--omp-thinking-xhigh": "#302e29",
		"--omp-status-bg": "#f0ede5",
		"--omp-status-model": "#5b574e",
		"--omp-status-path": "#686052",
		"--omp-status-git-clean": "#326747",
		"--omp-status-git-dirty": "#80601e",
		"--omp-status-context": "#5b574e",
		"--omp-status-spend": "#5b574e",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#686052",
		"--omp-status-dim": "#6c6254",
		"--omp-status-text": "#302e29",
		"--omp-status-sep": "#ded7ca",
		"--omp-muted": "#686052",
		"--omp-dim": "#6c6254",
		"--omp-link": "#825d2a",
		"--omp-custom-msg-label": "#825d2a",
		"--omp-input-bg": "#fffdf9",
		"--omp-input-border": "#ded7ca",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(134, 97, 45, 0.1)",
		"--omp-btn-primary-bg": "#302e29",
		"--omp-btn-primary-text": "#faf8f3",
		"--omp-btn-secondary-bg": "#e8e3d8",
		"--omp-btn-secondary-text": "#302e29",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#ffffff",
		"--omp-badge-bg": "#e8e3d8",
		"--omp-badge-text": "#5b574e",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(20, 28, 32, 0.28)",
		"--omp-modal-bg": "#fffdf9",
		"--omp-modal-border": "#ded7ca",
		"--omp-toast-bg": "#fffdf9",
		"--omp-toast-text": "#302e29",
		"--omp-toast-border": "#ded7ca",
		"--omp-progress-bg": "#e8e3d8",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#f0ede5",
		"--omp-sidebar-item-hover": "#e8e3d8",
		"--omp-sidebar-item-active": "rgba(134, 97, 45, 0.1)",
		"--omp-selection-bg": "rgba(134, 97, 45, 0.19)",
		"--omp-selection-text": "#302e29",
		"--omp-scrollbar-thumb": "#b4a68e",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(134, 97, 45, 0.04)",
		"--omp-panel-bg": "#f0ede5",
		"--omp-panel-border": "#e9e3d9",
		"--omp-panel-header": "#686052",
		"--omp-titlebar-bg": "#f0ede5",
		"--omp-titlebar-text": "#302e29",
		"--omp-shadow-sm": "0 1px 2px rgba(32, 40, 48, 0.035)",
		"--omp-shadow-md": "0 6px 18px rgba(32, 40, 48, 0.07)",
		"--omp-shadow-lg": "0 16px 48px rgba(32, 40, 48, 0.13)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const paper: ThemeDefinition = {
	label: "Ivory",
	description: "Warm ivory pages with a fine copper accent.",
	scheme: "light",
	tokens: {
		"--omp-accent": "#94513e",
		"--omp-accent-bright": "#7e4334",
		"--omp-accent-dim": "rgba(148, 81, 62, 0.08)",
		"--omp-accent-glow": "rgba(148, 81, 62, 0.16)",
		"--omp-border": "#dfd7cc",
		"--omp-border-accent": "rgba(148, 81, 62, 0.52)",
		"--omp-border-muted": "#ece5db",
		"--omp-border-strong": "#b6a594",
		"--omp-success": "#326747",
		"--omp-success-dim": "rgba(50, 103, 71, 0.08)",
		"--omp-error": "#9f4545",
		"--omp-error-dim": "rgba(159, 69, 69, 0.08)",
		"--omp-warning": "#80601e",
		"--omp-warning-dim": "rgba(128, 96, 30, 0.08)",
		"--omp-info": "#315f83",
		"--omp-info-dim": "rgba(49, 95, 131, 0.08)",
		"--omp-text": "#302d29",
		"--omp-text-secondary": "#5c554e",
		"--omp-bg-primary": "#fdfbf7",
		"--omp-bg-secondary": "#f5f1e9",
		"--omp-bg-tertiary": "#eae4da",
		"--omp-bg-elevated": "#fffefa",
		"--omp-selected-bg": "rgba(148, 81, 62, 0.09)",
		"--omp-user-msg-bg": "#f5f1e9",
		"--omp-user-msg-border": "#dfd7cc",
		"--omp-custom-msg-bg": "#f5f1e9",
		"--omp-code-bg": "#f5f1e9",
		"--omp-tool-pending-bg": "#f5f1e9",
		"--omp-tool-success-bg": "rgba(50, 103, 71, 0.045)",
		"--omp-tool-error-bg": "rgba(159, 69, 69, 0.065)",
		"--omp-tool-output": "#5c554e",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#326747",
		"--omp-tool-rail-error": "#9f4545",
		"--omp-md-heading": "#302d29",
		"--omp-md-link": "#94513e",
		"--omp-md-link-url": "#6a6057",
		"--omp-md-code": "#944c42",
		"--omp-md-code-block": "#302d29",
		"--omp-md-code-block-border": "#dfd7cc",
		"--omp-md-quote": "#5c554e",
		"--omp-md-quote-border": "#b6a594",
		"--omp-md-hr": "#dfd7cc",
		"--omp-md-list-bullet": "#6a6057",
		"--omp-diff-added": "#326747",
		"--omp-diff-added-bg": "rgba(50, 103, 71, 0.07)",
		"--omp-diff-removed": "#9f4545",
		"--omp-diff-removed-bg": "rgba(159, 69, 69, 0.07)",
		"--omp-diff-context": "#6a6057",
		"--omp-syntax-comment": "#6f6459",
		"--omp-syntax-keyword": "#315f83",
		"--omp-syntax-function": "#2b655f",
		"--omp-syntax-variable": "#302d29",
		"--omp-syntax-string": "#805c2e",
		"--omp-syntax-number": "#944c42",
		"--omp-syntax-type": "#516939",
		"--omp-syntax-operator": "#5c554e",
		"--omp-syntax-punctuation": "#6a6057",
		"--omp-thinking-off": "#6f6459",
		"--omp-thinking-minimal": "#6a6057",
		"--omp-thinking-low": "#5c554e",
		"--omp-thinking-medium": "#94513e",
		"--omp-thinking-high": "#7e4334",
		"--omp-thinking-xhigh": "#302d29",
		"--omp-status-bg": "#f3f0ea",
		"--omp-status-model": "#5c554e",
		"--omp-status-path": "#6a6057",
		"--omp-status-git-clean": "#326747",
		"--omp-status-git-dirty": "#80601e",
		"--omp-status-context": "#5c554e",
		"--omp-status-spend": "#5c554e",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#6a6057",
		"--omp-status-dim": "#6f6459",
		"--omp-status-text": "#302d29",
		"--omp-status-sep": "#dfd7cc",
		"--omp-muted": "#6a6057",
		"--omp-dim": "#6f6459",
		"--omp-link": "#94513e",
		"--omp-custom-msg-label": "#94513e",
		"--omp-input-bg": "#fffefa",
		"--omp-input-border": "#dfd7cc",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(148, 81, 62, 0.1)",
		"--omp-btn-primary-bg": "#302d29",
		"--omp-btn-primary-text": "#fdfbf7",
		"--omp-btn-secondary-bg": "#eae4da",
		"--omp-btn-secondary-text": "#302d29",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#ffffff",
		"--omp-badge-bg": "#eae4da",
		"--omp-badge-text": "#5c554e",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(20, 28, 32, 0.28)",
		"--omp-modal-bg": "#fffefa",
		"--omp-modal-border": "#dfd7cc",
		"--omp-toast-bg": "#fffefa",
		"--omp-toast-text": "#302d29",
		"--omp-toast-border": "#dfd7cc",
		"--omp-progress-bg": "#eae4da",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#f3f0ea",
		"--omp-sidebar-item-hover": "#eae4da",
		"--omp-sidebar-item-active": "rgba(148, 81, 62, 0.1)",
		"--omp-selection-bg": "rgba(148, 81, 62, 0.19)",
		"--omp-selection-text": "#302d29",
		"--omp-scrollbar-thumb": "#b6a594",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(148, 81, 62, 0.04)",
		"--omp-panel-bg": "#f3f0ea",
		"--omp-panel-border": "#ece5db",
		"--omp-panel-header": "#6a6057",
		"--omp-titlebar-bg": "#f3f0ea",
		"--omp-titlebar-text": "#302d29",
		"--omp-shadow-sm": "0 1px 2px rgba(32, 40, 48, 0.035)",
		"--omp-shadow-md": "0 6px 18px rgba(32, 40, 48, 0.07)",
		"--omp-shadow-lg": "0 16px 48px rgba(32, 40, 48, 0.13)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const dawn: ThemeDefinition = {
	label: "Rose Quartz",
	description: "Almost-white rose, warm ink, and a dusty rose accent.",
	scheme: "light",
	tokens: {
		"--omp-accent": "#8d5064",
		"--omp-accent-bright": "#784455",
		"--omp-accent-dim": "rgba(141, 80, 100, 0.08)",
		"--omp-accent-glow": "rgba(141, 80, 100, 0.16)",
		"--omp-border": "#e2d6da",
		"--omp-border-accent": "rgba(141, 80, 100, 0.52)",
		"--omp-border-muted": "#ede3e7",
		"--omp-border-strong": "#bba1aa",
		"--omp-success": "#326747",
		"--omp-success-dim": "rgba(50, 103, 71, 0.08)",
		"--omp-error": "#9f4545",
		"--omp-error-dim": "rgba(159, 69, 69, 0.08)",
		"--omp-warning": "#80601e",
		"--omp-warning-dim": "rgba(128, 96, 30, 0.08)",
		"--omp-info": "#315f83",
		"--omp-info-dim": "rgba(49, 95, 131, 0.08)",
		"--omp-text": "#342b2d",
		"--omp-text-secondary": "#605257",
		"--omp-bg-primary": "#fcf9f9",
		"--omp-bg-secondary": "#f5eeee",
		"--omp-bg-tertiary": "#ece1e2",
		"--omp-bg-elevated": "#fffdfd",
		"--omp-selected-bg": "rgba(141, 80, 100, 0.09)",
		"--omp-user-msg-bg": "#f5eeee",
		"--omp-user-msg-border": "#e2d6da",
		"--omp-custom-msg-bg": "#f5eeee",
		"--omp-code-bg": "#f5eeee",
		"--omp-tool-pending-bg": "#f5eeee",
		"--omp-tool-success-bg": "rgba(50, 103, 71, 0.045)",
		"--omp-tool-error-bg": "rgba(159, 69, 69, 0.065)",
		"--omp-tool-output": "#605257",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#326747",
		"--omp-tool-rail-error": "#9f4545",
		"--omp-md-heading": "#342b2d",
		"--omp-md-link": "#8d5064",
		"--omp-md-link-url": "#6e5e64",
		"--omp-md-code": "#944c42",
		"--omp-md-code-block": "#342b2d",
		"--omp-md-code-block-border": "#e2d6da",
		"--omp-md-quote": "#605257",
		"--omp-md-quote-border": "#bba1aa",
		"--omp-md-hr": "#e2d6da",
		"--omp-md-list-bullet": "#6e5e64",
		"--omp-diff-added": "#326747",
		"--omp-diff-added-bg": "rgba(50, 103, 71, 0.07)",
		"--omp-diff-removed": "#9f4545",
		"--omp-diff-removed-bg": "rgba(159, 69, 69, 0.07)",
		"--omp-diff-context": "#6e5e64",
		"--omp-syntax-comment": "#716067",
		"--omp-syntax-keyword": "#315f83",
		"--omp-syntax-function": "#2b655f",
		"--omp-syntax-variable": "#342b2d",
		"--omp-syntax-string": "#805c2e",
		"--omp-syntax-number": "#944c42",
		"--omp-syntax-type": "#516939",
		"--omp-syntax-operator": "#605257",
		"--omp-syntax-punctuation": "#6e5e64",
		"--omp-thinking-off": "#716067",
		"--omp-thinking-minimal": "#6e5e64",
		"--omp-thinking-low": "#605257",
		"--omp-thinking-medium": "#8d5064",
		"--omp-thinking-high": "#784455",
		"--omp-thinking-xhigh": "#342b2d",
		"--omp-status-bg": "#f3eded",
		"--omp-status-model": "#605257",
		"--omp-status-path": "#6e5e64",
		"--omp-status-git-clean": "#326747",
		"--omp-status-git-dirty": "#80601e",
		"--omp-status-context": "#605257",
		"--omp-status-spend": "#605257",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#6e5e64",
		"--omp-status-dim": "#716067",
		"--omp-status-text": "#342b2d",
		"--omp-status-sep": "#e2d6da",
		"--omp-muted": "#6e5e64",
		"--omp-dim": "#716067",
		"--omp-link": "#8d5064",
		"--omp-custom-msg-label": "#8d5064",
		"--omp-input-bg": "#fffdfd",
		"--omp-input-border": "#e2d6da",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(141, 80, 100, 0.1)",
		"--omp-btn-primary-bg": "#342b2d",
		"--omp-btn-primary-text": "#fcf9f9",
		"--omp-btn-secondary-bg": "#ece1e2",
		"--omp-btn-secondary-text": "#342b2d",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#ffffff",
		"--omp-badge-bg": "#ece1e2",
		"--omp-badge-text": "#605257",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(20, 28, 32, 0.28)",
		"--omp-modal-bg": "#fffdfd",
		"--omp-modal-border": "#e2d6da",
		"--omp-toast-bg": "#fffdfd",
		"--omp-toast-text": "#342b2d",
		"--omp-toast-border": "#e2d6da",
		"--omp-progress-bg": "#ece1e2",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#f3eded",
		"--omp-sidebar-item-hover": "#ece1e2",
		"--omp-sidebar-item-active": "rgba(141, 80, 100, 0.1)",
		"--omp-selection-bg": "rgba(141, 80, 100, 0.19)",
		"--omp-selection-text": "#342b2d",
		"--omp-scrollbar-thumb": "#bba1aa",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(141, 80, 100, 0.04)",
		"--omp-panel-bg": "#f3eded",
		"--omp-panel-border": "#ede3e7",
		"--omp-panel-header": "#6e5e64",
		"--omp-titlebar-bg": "#f3eded",
		"--omp-titlebar-text": "#342b2d",
		"--omp-shadow-sm": "0 1px 2px rgba(32, 40, 48, 0.035)",
		"--omp-shadow-md": "0 6px 18px rgba(32, 40, 48, 0.07)",
		"--omp-shadow-lg": "0 16px 48px rgba(32, 40, 48, 0.13)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const latte: ThemeDefinition = {
	label: "Espresso",
	description: "Roasted coffee surfaces and a soft caramel accent.",
	scheme: "dark",
	tokens: {
		"--omp-accent": "#d6b18a",
		"--omp-accent-bright": "#e7caaa",
		"--omp-accent-dim": "rgba(214, 177, 138, 0.13)",
		"--omp-accent-glow": "rgba(214, 177, 138, 0.16)",
		"--omp-border": "#4b4036",
		"--omp-border-accent": "rgba(214, 177, 138, 0.52)",
		"--omp-border-muted": "#3b332c",
		"--omp-border-strong": "#7b6857",
		"--omp-success": "#9bc7ab",
		"--omp-success-dim": "rgba(155, 199, 171, 0.08)",
		"--omp-error": "#e6a09a",
		"--omp-error-dim": "rgba(230, 160, 154, 0.08)",
		"--omp-warning": "#d7bc88",
		"--omp-warning-dim": "rgba(215, 188, 136, 0.08)",
		"--omp-info": "#a2bfdc",
		"--omp-info-dim": "rgba(162, 191, 220, 0.08)",
		"--omp-text": "#eee8e0",
		"--omp-text-secondary": "#cec2b6",
		"--omp-bg-primary": "#25211e",
		"--omp-bg-secondary": "#2d2824",
		"--omp-bg-tertiary": "#39312b",
		"--omp-bg-elevated": "#3d352f",
		"--omp-selected-bg": "rgba(214, 177, 138, 0.12)",
		"--omp-user-msg-bg": "#2d2824",
		"--omp-user-msg-border": "#4b4036",
		"--omp-custom-msg-bg": "#2d2824",
		"--omp-code-bg": "#2d2824",
		"--omp-tool-pending-bg": "#2d2824",
		"--omp-tool-success-bg": "rgba(155, 199, 171, 0.045)",
		"--omp-tool-error-bg": "rgba(230, 160, 154, 0.065)",
		"--omp-tool-output": "#cec2b6",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#9bc7ab",
		"--omp-tool-rail-error": "#e6a09a",
		"--omp-md-heading": "#eee8e0",
		"--omp-md-link": "#d6b18a",
		"--omp-md-link-url": "#beafa1",
		"--omp-md-code": "#deb0a1",
		"--omp-md-code-block": "#eee8e0",
		"--omp-md-code-block-border": "#4b4036",
		"--omp-md-quote": "#cec2b6",
		"--omp-md-quote-border": "#7b6857",
		"--omp-md-hr": "#4b4036",
		"--omp-md-list-bullet": "#beafa1",
		"--omp-diff-added": "#9bc7ab",
		"--omp-diff-added-bg": "rgba(155, 199, 171, 0.09)",
		"--omp-diff-removed": "#e6a09a",
		"--omp-diff-removed-bg": "rgba(230, 160, 154, 0.09)",
		"--omp-diff-context": "#beafa1",
		"--omp-syntax-comment": "#b3a496",
		"--omp-syntax-keyword": "#a3bedb",
		"--omp-syntax-function": "#91c5bf",
		"--omp-syntax-variable": "#eee8e0",
		"--omp-syntax-string": "#d4ba91",
		"--omp-syntax-number": "#deb0a1",
		"--omp-syntax-type": "#b9cdb1",
		"--omp-syntax-operator": "#cec2b6",
		"--omp-syntax-punctuation": "#beafa1",
		"--omp-thinking-off": "#b3a496",
		"--omp-thinking-minimal": "#beafa1",
		"--omp-thinking-low": "#cec2b6",
		"--omp-thinking-medium": "#d6b18a",
		"--omp-thinking-high": "#e7caaa",
		"--omp-thinking-xhigh": "#eee8e0",
		"--omp-status-bg": "#1e1b18",
		"--omp-status-model": "#cec2b6",
		"--omp-status-path": "#beafa1",
		"--omp-status-git-clean": "#9bc7ab",
		"--omp-status-git-dirty": "#d7bc88",
		"--omp-status-context": "#cec2b6",
		"--omp-status-spend": "#cec2b6",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#beafa1",
		"--omp-status-dim": "#b3a496",
		"--omp-status-text": "#eee8e0",
		"--omp-status-sep": "#4b4036",
		"--omp-muted": "#beafa1",
		"--omp-dim": "#b3a496",
		"--omp-link": "#d6b18a",
		"--omp-custom-msg-label": "#d6b18a",
		"--omp-input-bg": "#2d2824",
		"--omp-input-border": "#4b4036",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(214, 177, 138, 0.1)",
		"--omp-btn-primary-bg": "#eee8e0",
		"--omp-btn-primary-text": "#25211e",
		"--omp-btn-secondary-bg": "#39312b",
		"--omp-btn-secondary-text": "#eee8e0",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#25211e",
		"--omp-badge-bg": "#39312b",
		"--omp-badge-text": "#cec2b6",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(8, 12, 16, 0.62)",
		"--omp-modal-bg": "#3d352f",
		"--omp-modal-border": "#4b4036",
		"--omp-toast-bg": "#3d352f",
		"--omp-toast-text": "#eee8e0",
		"--omp-toast-border": "#4b4036",
		"--omp-progress-bg": "#39312b",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#1e1b18",
		"--omp-sidebar-item-hover": "#39312b",
		"--omp-sidebar-item-active": "rgba(214, 177, 138, 0.13)",
		"--omp-selection-bg": "rgba(214, 177, 138, 0.25)",
		"--omp-selection-text": "#eee8e0",
		"--omp-scrollbar-thumb": "#7b6857",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(214, 177, 138, 0.04)",
		"--omp-panel-bg": "#1e1b18",
		"--omp-panel-border": "#3b332c",
		"--omp-panel-header": "#beafa1",
		"--omp-titlebar-bg": "#1e1b18",
		"--omp-titlebar-text": "#eee8e0",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.16)",
		"--omp-shadow-md": "0 6px 18px rgba(0, 0, 0, 0.22)",
		"--omp-shadow-lg": "0 16px 48px rgba(0, 0, 0, 0.32)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const gruvbox: ThemeDefinition = {
	label: "Ember",
	description: "Warm charcoal with a low, copper ember.",
	scheme: "dark",
	tokens: {
		"--omp-accent": "#dea28d",
		"--omp-accent-bright": "#eac2b3",
		"--omp-accent-dim": "rgba(222, 162, 141, 0.13)",
		"--omp-accent-glow": "rgba(222, 162, 141, 0.16)",
		"--omp-border": "#4c3d40",
		"--omp-border-accent": "rgba(222, 162, 141, 0.52)",
		"--omp-border-muted": "#3c3033",
		"--omp-border-strong": "#7c5f64",
		"--omp-success": "#9bc7ab",
		"--omp-success-dim": "rgba(155, 199, 171, 0.08)",
		"--omp-error": "#e6a09a",
		"--omp-error-dim": "rgba(230, 160, 154, 0.08)",
		"--omp-warning": "#d7bc88",
		"--omp-warning-dim": "rgba(215, 188, 136, 0.08)",
		"--omp-info": "#a2bfdc",
		"--omp-info-dim": "rgba(162, 191, 220, 0.08)",
		"--omp-text": "#f0e7e5",
		"--omp-text-secondary": "#d0bfbd",
		"--omp-bg-primary": "#241e20",
		"--omp-bg-secondary": "#2c2527",
		"--omp-bg-tertiary": "#392e30",
		"--omp-bg-elevated": "#3e3235",
		"--omp-selected-bg": "rgba(222, 162, 141, 0.12)",
		"--omp-user-msg-bg": "#2c2527",
		"--omp-user-msg-border": "#4c3d40",
		"--omp-custom-msg-bg": "#2c2527",
		"--omp-code-bg": "#2c2527",
		"--omp-tool-pending-bg": "#2c2527",
		"--omp-tool-success-bg": "rgba(155, 199, 171, 0.045)",
		"--omp-tool-error-bg": "rgba(230, 160, 154, 0.065)",
		"--omp-tool-output": "#d0bfbd",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#9bc7ab",
		"--omp-tool-rail-error": "#e6a09a",
		"--omp-md-heading": "#f0e7e5",
		"--omp-md-link": "#dea28d",
		"--omp-md-link-url": "#c0adaa",
		"--omp-md-code": "#deb0a1",
		"--omp-md-code-block": "#f0e7e5",
		"--omp-md-code-block-border": "#4c3d40",
		"--omp-md-quote": "#d0bfbd",
		"--omp-md-quote-border": "#7c5f64",
		"--omp-md-hr": "#4c3d40",
		"--omp-md-list-bullet": "#c0adaa",
		"--omp-diff-added": "#9bc7ab",
		"--omp-diff-added-bg": "rgba(155, 199, 171, 0.09)",
		"--omp-diff-removed": "#e6a09a",
		"--omp-diff-removed-bg": "rgba(230, 160, 154, 0.09)",
		"--omp-diff-context": "#c0adaa",
		"--omp-syntax-comment": "#b9a39f",
		"--omp-syntax-keyword": "#a3bedb",
		"--omp-syntax-function": "#91c5bf",
		"--omp-syntax-variable": "#f0e7e5",
		"--omp-syntax-string": "#d4ba91",
		"--omp-syntax-number": "#deb0a1",
		"--omp-syntax-type": "#b9cdb1",
		"--omp-syntax-operator": "#d0bfbd",
		"--omp-syntax-punctuation": "#c0adaa",
		"--omp-thinking-off": "#b9a39f",
		"--omp-thinking-minimal": "#c0adaa",
		"--omp-thinking-low": "#d0bfbd",
		"--omp-thinking-medium": "#dea28d",
		"--omp-thinking-high": "#eac2b3",
		"--omp-thinking-xhigh": "#f0e7e5",
		"--omp-status-bg": "#1c181a",
		"--omp-status-model": "#d0bfbd",
		"--omp-status-path": "#c0adaa",
		"--omp-status-git-clean": "#9bc7ab",
		"--omp-status-git-dirty": "#d7bc88",
		"--omp-status-context": "#d0bfbd",
		"--omp-status-spend": "#d0bfbd",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#c0adaa",
		"--omp-status-dim": "#b9a39f",
		"--omp-status-text": "#f0e7e5",
		"--omp-status-sep": "#4c3d40",
		"--omp-muted": "#c0adaa",
		"--omp-dim": "#b9a39f",
		"--omp-link": "#dea28d",
		"--omp-custom-msg-label": "#dea28d",
		"--omp-input-bg": "#2c2527",
		"--omp-input-border": "#4c3d40",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(222, 162, 141, 0.1)",
		"--omp-btn-primary-bg": "#f0e7e5",
		"--omp-btn-primary-text": "#241e20",
		"--omp-btn-secondary-bg": "#392e30",
		"--omp-btn-secondary-text": "#f0e7e5",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#241e20",
		"--omp-badge-bg": "#392e30",
		"--omp-badge-text": "#d0bfbd",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(8, 12, 16, 0.62)",
		"--omp-modal-bg": "#3e3235",
		"--omp-modal-border": "#4c3d40",
		"--omp-toast-bg": "#3e3235",
		"--omp-toast-text": "#f0e7e5",
		"--omp-toast-border": "#4c3d40",
		"--omp-progress-bg": "#392e30",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#1c181a",
		"--omp-sidebar-item-hover": "#392e30",
		"--omp-sidebar-item-active": "rgba(222, 162, 141, 0.13)",
		"--omp-selection-bg": "rgba(222, 162, 141, 0.25)",
		"--omp-selection-text": "#f0e7e5",
		"--omp-scrollbar-thumb": "#7c5f64",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(222, 162, 141, 0.04)",
		"--omp-panel-bg": "#1c181a",
		"--omp-panel-border": "#3c3033",
		"--omp-panel-header": "#c0adaa",
		"--omp-titlebar-bg": "#1c181a",
		"--omp-titlebar-text": "#f0e7e5",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.16)",
		"--omp-shadow-md": "0 6px 18px rgba(0, 0, 0, 0.22)",
		"--omp-shadow-lg": "0 16px 48px rgba(0, 0, 0, 0.32)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const frost: ThemeDefinition = {
	label: "Glacier",
	description: "Airy ice-white with a clear steel-blue accent.",
	scheme: "light",
	tokens: {
		"--omp-accent": "#356987",
		"--omp-accent-bright": "#2a5570",
		"--omp-accent-dim": "rgba(53, 105, 135, 0.08)",
		"--omp-accent-glow": "rgba(53, 105, 135, 0.16)",
		"--omp-border": "#d2dfe5",
		"--omp-border-accent": "rgba(53, 105, 135, 0.52)",
		"--omp-border-muted": "#e0e9ed",
		"--omp-border-strong": "#96aebc",
		"--omp-success": "#326747",
		"--omp-success-dim": "rgba(50, 103, 71, 0.08)",
		"--omp-error": "#9f4545",
		"--omp-error-dim": "rgba(159, 69, 69, 0.08)",
		"--omp-warning": "#80601e",
		"--omp-warning-dim": "rgba(128, 96, 30, 0.08)",
		"--omp-info": "#315f83",
		"--omp-info-dim": "rgba(49, 95, 131, 0.08)",
		"--omp-text": "#26343c",
		"--omp-text-secondary": "#4e606b",
		"--omp-bg-primary": "#f7fafb",
		"--omp-bg-secondary": "#eef4f6",
		"--omp-bg-tertiary": "#e2eaee",
		"--omp-bg-elevated": "#fcfeff",
		"--omp-selected-bg": "rgba(53, 105, 135, 0.09)",
		"--omp-user-msg-bg": "#eef4f6",
		"--omp-user-msg-border": "#d2dfe5",
		"--omp-custom-msg-bg": "#eef4f6",
		"--omp-code-bg": "#eef4f6",
		"--omp-tool-pending-bg": "#eef4f6",
		"--omp-tool-success-bg": "rgba(50, 103, 71, 0.045)",
		"--omp-tool-error-bg": "rgba(159, 69, 69, 0.065)",
		"--omp-tool-output": "#4e606b",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#326747",
		"--omp-tool-rail-error": "#9f4545",
		"--omp-md-heading": "#26343c",
		"--omp-md-link": "#356987",
		"--omp-md-link-url": "#566872",
		"--omp-md-code": "#944c42",
		"--omp-md-code-block": "#26343c",
		"--omp-md-code-block-border": "#d2dfe5",
		"--omp-md-quote": "#4e606b",
		"--omp-md-quote-border": "#96aebc",
		"--omp-md-hr": "#d2dfe5",
		"--omp-md-list-bullet": "#566872",
		"--omp-diff-added": "#326747",
		"--omp-diff-added-bg": "rgba(50, 103, 71, 0.07)",
		"--omp-diff-removed": "#9f4545",
		"--omp-diff-removed-bg": "rgba(159, 69, 69, 0.07)",
		"--omp-diff-context": "#566872",
		"--omp-syntax-comment": "#586a74",
		"--omp-syntax-keyword": "#315f83",
		"--omp-syntax-function": "#2b655f",
		"--omp-syntax-variable": "#26343c",
		"--omp-syntax-string": "#805c2e",
		"--omp-syntax-number": "#944c42",
		"--omp-syntax-type": "#516939",
		"--omp-syntax-operator": "#4e606b",
		"--omp-syntax-punctuation": "#566872",
		"--omp-thinking-off": "#586a74",
		"--omp-thinking-minimal": "#566872",
		"--omp-thinking-low": "#4e606b",
		"--omp-thinking-medium": "#356987",
		"--omp-thinking-high": "#2a5570",
		"--omp-thinking-xhigh": "#26343c",
		"--omp-status-bg": "#edf2f4",
		"--omp-status-model": "#4e606b",
		"--omp-status-path": "#566872",
		"--omp-status-git-clean": "#326747",
		"--omp-status-git-dirty": "#80601e",
		"--omp-status-context": "#4e606b",
		"--omp-status-spend": "#4e606b",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#566872",
		"--omp-status-dim": "#586a74",
		"--omp-status-text": "#26343c",
		"--omp-status-sep": "#d2dfe5",
		"--omp-muted": "#566872",
		"--omp-dim": "#586a74",
		"--omp-link": "#356987",
		"--omp-custom-msg-label": "#356987",
		"--omp-input-bg": "#fcfeff",
		"--omp-input-border": "#d2dfe5",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(53, 105, 135, 0.1)",
		"--omp-btn-primary-bg": "#26343c",
		"--omp-btn-primary-text": "#f7fafb",
		"--omp-btn-secondary-bg": "#e2eaee",
		"--omp-btn-secondary-text": "#26343c",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#ffffff",
		"--omp-badge-bg": "#e2eaee",
		"--omp-badge-text": "#4e606b",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(20, 28, 32, 0.28)",
		"--omp-modal-bg": "#fcfeff",
		"--omp-modal-border": "#d2dfe5",
		"--omp-toast-bg": "#fcfeff",
		"--omp-toast-text": "#26343c",
		"--omp-toast-border": "#d2dfe5",
		"--omp-progress-bg": "#e2eaee",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#edf2f4",
		"--omp-sidebar-item-hover": "#e2eaee",
		"--omp-sidebar-item-active": "rgba(53, 105, 135, 0.1)",
		"--omp-selection-bg": "rgba(53, 105, 135, 0.19)",
		"--omp-selection-text": "#26343c",
		"--omp-scrollbar-thumb": "#96aebc",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(53, 105, 135, 0.04)",
		"--omp-panel-bg": "#edf2f4",
		"--omp-panel-border": "#e0e9ed",
		"--omp-panel-header": "#566872",
		"--omp-titlebar-bg": "#edf2f4",
		"--omp-titlebar-text": "#26343c",
		"--omp-shadow-sm": "0 1px 2px rgba(32, 40, 48, 0.035)",
		"--omp-shadow-md": "0 6px 18px rgba(32, 40, 48, 0.07)",
		"--omp-shadow-lg": "0 16px 48px rgba(32, 40, 48, 0.13)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

const matcha: ThemeDefinition = {
	label: "Sage",
	description: "Quiet chalk green and a natural sage accent.",
	scheme: "light",
	tokens: {
		"--omp-accent": "#466d51",
		"--omp-accent-bright": "#395941",
		"--omp-accent-dim": "rgba(70, 109, 81, 0.08)",
		"--omp-accent-glow": "rgba(70, 109, 81, 0.16)",
		"--omp-border": "#d6dfd0",
		"--omp-border-accent": "rgba(70, 109, 81, 0.52)",
		"--omp-border-muted": "#e3eade",
		"--omp-border-strong": "#a4b49a",
		"--omp-success": "#326747",
		"--omp-success-dim": "rgba(50, 103, 71, 0.08)",
		"--omp-error": "#9f4545",
		"--omp-error-dim": "rgba(159, 69, 69, 0.08)",
		"--omp-warning": "#80601e",
		"--omp-warning-dim": "rgba(128, 96, 30, 0.08)",
		"--omp-info": "#315f83",
		"--omp-info-dim": "rgba(49, 95, 131, 0.08)",
		"--omp-text": "#2c352c",
		"--omp-text-secondary": "#54614f",
		"--omp-bg-primary": "#f8faf7",
		"--omp-bg-secondary": "#f0f4ed",
		"--omp-bg-tertiary": "#e3eadf",
		"--omp-bg-elevated": "#fcfdfa",
		"--omp-selected-bg": "rgba(70, 109, 81, 0.09)",
		"--omp-user-msg-bg": "#f0f4ed",
		"--omp-user-msg-border": "#d6dfd0",
		"--omp-custom-msg-bg": "#f0f4ed",
		"--omp-code-bg": "#f0f4ed",
		"--omp-tool-pending-bg": "#f0f4ed",
		"--omp-tool-success-bg": "rgba(50, 103, 71, 0.045)",
		"--omp-tool-error-bg": "rgba(159, 69, 69, 0.065)",
		"--omp-tool-output": "#54614f",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#326747",
		"--omp-tool-rail-error": "#9f4545",
		"--omp-md-heading": "#2c352c",
		"--omp-md-link": "#466d51",
		"--omp-md-link-url": "#5e6958",
		"--omp-md-code": "#944c42",
		"--omp-md-code-block": "#2c352c",
		"--omp-md-code-block-border": "#d6dfd0",
		"--omp-md-quote": "#54614f",
		"--omp-md-quote-border": "#a4b49a",
		"--omp-md-hr": "#d6dfd0",
		"--omp-md-list-bullet": "#5e6958",
		"--omp-diff-added": "#326747",
		"--omp-diff-added-bg": "rgba(50, 103, 71, 0.07)",
		"--omp-diff-removed": "#9f4545",
		"--omp-diff-removed-bg": "rgba(159, 69, 69, 0.07)",
		"--omp-diff-context": "#5e6958",
		"--omp-syntax-comment": "#5e6b58",
		"--omp-syntax-keyword": "#315f83",
		"--omp-syntax-function": "#2b655f",
		"--omp-syntax-variable": "#2c352c",
		"--omp-syntax-string": "#805c2e",
		"--omp-syntax-number": "#944c42",
		"--omp-syntax-type": "#516939",
		"--omp-syntax-operator": "#54614f",
		"--omp-syntax-punctuation": "#5e6958",
		"--omp-thinking-off": "#5e6b58",
		"--omp-thinking-minimal": "#5e6958",
		"--omp-thinking-low": "#54614f",
		"--omp-thinking-medium": "#466d51",
		"--omp-thinking-high": "#395941",
		"--omp-thinking-xhigh": "#2c352c",
		"--omp-status-bg": "#eef2eb",
		"--omp-status-model": "#54614f",
		"--omp-status-path": "#5e6958",
		"--omp-status-git-clean": "#326747",
		"--omp-status-git-dirty": "#80601e",
		"--omp-status-context": "#54614f",
		"--omp-status-spend": "#54614f",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#5e6958",
		"--omp-status-dim": "#5e6b58",
		"--omp-status-text": "#2c352c",
		"--omp-status-sep": "#d6dfd0",
		"--omp-muted": "#5e6958",
		"--omp-dim": "#5e6b58",
		"--omp-link": "#466d51",
		"--omp-custom-msg-label": "#466d51",
		"--omp-input-bg": "#fcfdfa",
		"--omp-input-border": "#d6dfd0",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(70, 109, 81, 0.1)",
		"--omp-btn-primary-bg": "#2c352c",
		"--omp-btn-primary-text": "#f8faf7",
		"--omp-btn-secondary-bg": "#e3eadf",
		"--omp-btn-secondary-text": "#2c352c",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#ffffff",
		"--omp-badge-bg": "#e3eadf",
		"--omp-badge-text": "#54614f",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(20, 28, 32, 0.28)",
		"--omp-modal-bg": "#fcfdfa",
		"--omp-modal-border": "#d6dfd0",
		"--omp-toast-bg": "#fcfdfa",
		"--omp-toast-text": "#2c352c",
		"--omp-toast-border": "#d6dfd0",
		"--omp-progress-bg": "#e3eadf",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#eef2eb",
		"--omp-sidebar-item-hover": "#e3eadf",
		"--omp-sidebar-item-active": "rgba(70, 109, 81, 0.1)",
		"--omp-selection-bg": "rgba(70, 109, 81, 0.19)",
		"--omp-selection-text": "#2c352c",
		"--omp-scrollbar-thumb": "#a4b49a",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(70, 109, 81, 0.04)",
		"--omp-panel-bg": "#eef2eb",
		"--omp-panel-border": "#e3eade",
		"--omp-panel-header": "#5e6958",
		"--omp-titlebar-bg": "#eef2eb",
		"--omp-titlebar-text": "#2c352c",
		"--omp-shadow-sm": "0 1px 2px rgba(32, 40, 48, 0.035)",
		"--omp-shadow-md": "0 6px 18px rgba(32, 40, 48, 0.07)",
		"--omp-shadow-lg": "0 16px 48px rgba(32, 40, 48, 0.13)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent)",
	},
};

// Selection IDs remain stable so existing preferences survive the redesign.
export const THEMES = {
	dark,
	titanium,
	nord,
	latte,
	gruvbox,
	light,
	paper,
	solarized,
	dawn,
	frost,
	matcha,
} as const satisfies Record<string, ThemeDefinition>;

export type ThemeName = keyof typeof THEMES;

/** A picker selection: a named theme, or "system" to follow the OS. */
export type ThemeSelection = ThemeName | "system";

export function isThemeSelection(value: unknown): value is ThemeSelection {
	return typeof value === "string" && (value === "system" || value in THEMES);
}

/** The theme actually shown for a selection ("system" resolves via the OS). */
export function resolveThemeSelection(selection: ThemeSelection): ThemeDefinition {
	return THEMES[selection === "system" ? resolveTheme("system") : selection];
}

/**
 * Inline tokens most recently written by applyThemeByName for a named theme;
 * null while the "system" selection is stylesheet-driven. The agent theme
 * overlay (bottom of this file) restores these when an override goes away.
 */
let baseThemeTokens: ThemeTokens | null = null;
let themeSelectionVersion = 0;

export function getThemeSelectionVersion(): number {
	return themeSelectionVersion;
}

/**
 * Applies a theme selection live: flips `data-theme` + the color-scheme meta
 * to the theme's base scheme, then writes every token inline on <html>.
 * "system" stays purely stylesheet-driven (dark/light resolve per the OS
 * media query, and lib/theme's watcher re-applies on OS changes). Persists
 * the selection under the `themeName` pref and mirrors the base scheme (or
 * "system") into the legacy `theme` pref so older boot paths stay coherent.
 * Pass `{ persist: false }` for ephemeral previews (settings-window theme
 * browsing) so the user's stored selection is left untouched.
 */
export function applyThemeByName(selection: ThemeSelection, opts: { persist?: boolean } = {}): void {
	themeSelectionVersion++;
	const { persist = true } = opts;
	const legacyTheme = selection === "system" ? "system" : THEMES[selection].scheme;
	if (selection !== "system") {
		const theme = THEMES[selection];
		applyTheme(theme.scheme);
		const style = document.documentElement.style;
		for (const key of THEME_TOKEN_KEYS) style.setProperty(key, theme.tokens[key]);
		for (const [key, value] of Object.entries(scTokensFor(theme))) style.setProperty(key, value);
		baseThemeTokens = theme.tokens;
		markCustomThemeTokens(theme.scheme);
	} else {
		baseThemeTokens = null;
		applyTheme("system");
	}
	writeOverlay();
	if (persist) {
		void saveGuiPreference("themeName", selection, () => {});
		void saveGuiPreference("theme", legacyTheme, () => {});
		try {
			localStorage.setItem(THEME_SCHEME_STORAGE_KEY, selection === "system" ? "system" : THEMES[selection].scheme);
		} catch {
			// localStorage unavailable — the async path still applies the theme.
		}
	}
}

/**
 * Reads the persisted selection: the `themeName` pref first, then the legacy
 * `theme` pref (dark/light/system written by older builds and the settings
 * window), falling back to "system" — seucode follows the OS by default.
 */
export async function getPersistedThemeSelection(prefs?: Readonly<Record<string, unknown>>): Promise<ThemeSelection> {
	if (prefs) {
		if (isThemeSelection(prefs.themeName)) return prefs.themeName;
		return isThemeSelection(prefs.theme) ? prefs.theme : "system";
	}
	try {
		const named = await window.omp.prefs.get("themeName");
		if (isThemeSelection(named)) return named;
		const legacy = await window.omp.prefs.get("theme");
		if (isThemeSelection(legacy)) return legacy;
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
	toolSuccessBg: "--omp-tool-success-bg",
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
