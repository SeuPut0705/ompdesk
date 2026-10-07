/**
 * chart.js registration + theme-aware defaults for the Insights stats views.
 * Every stats route imports this module for its side effects before rendering
 * react-chartjs-2 charts.
 *
 * Colors come from the ompdesk tokens (`--sc-*`), read when a chart renders,
 * so light/dark and the named themes all apply. Canvas charts don't follow CSS
 * changes on their own: `useChartThemeKey()` changes whenever the root theme
 * changes (data-theme, inline token map, font size), and chart views key on it
 * so they re-render with fresh colors.
 */

import {
	ArcElement,
	BarElement,
	CategoryScale,
	Chart,
	Filler,
	Legend,
	LinearScale,
	LineElement,
	PointElement,
	Tooltip,
} from "chart.js";
import { useSyncExternalStore } from "react";
import { formatCost } from "./format";

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Filler, Tooltip, Legend);

/** Scheme fallbacks, used only when the theme stylesheets failed to load (Porcelain / Graphite). */
const FALLBACK = {
	light: {
		"--sc-text": "#1b1b1f",
		"--sc-text-secondary": "#46464f",
		"--sc-text-muted": "#5f5f68",
		"--sc-divider": "#ebebee",
		"--sc-border-subtle": "#dcdce2",
		"--sc-elevated": "#ffffff",
		"--sc-accent": "#5b5bd6",
		"--sc-info": "#2f62c4",
		"--sc-success": "#18794e",
		"--sc-warning": "#935f00",
		"--sc-danger": "#bf3a3e",
	},
	dark: {
		"--sc-text": "#ededf0",
		"--sc-text-secondary": "#c4c4cb",
		"--sc-text-muted": "#a1a1aa",
		"--sc-divider": "#2a2a30",
		"--sc-border-subtle": "#3a3a41",
		"--sc-elevated": "#232327",
		"--sc-accent": "#8b8df8",
		"--sc-info": "#79a6f6",
		"--sc-success": "#5bc98c",
		"--sc-warning": "#e2b552",
		"--sc-danger": "#f27a7d",
	},
} as const;

type TokenName = keyof (typeof FALLBACK)["light"];

function scheme(): "light" | "dark" {
	const attr = document.documentElement.getAttribute("data-theme");
	if (attr === "light" || attr === "dark") return attr;
	const osLight =
		typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;
	return osLight ? "light" : "dark";
}

function token(name: TokenName): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || FALLBACK[scheme()][name];
}

/**
 * Categorical palette for multi-series charts (cycled). Semantic tokens first
 * (accent, info, success, warning, danger), then the theme's syntax hues for
 * spread; exact duplicates (small palettes reuse hues) are removed.
 */
const SERIES_TOKENS = [
	"--sc-accent",
	"--sc-info",
	"--sc-success",
	"--sc-warning",
	"--sc-danger",
	"--omp-syntax-string",
	"--omp-syntax-type",
	"--omp-thinking-xhigh",
	"--sc-text-muted",
] as const;

export function chartColors(): string[] {
	const style = getComputedStyle(document.documentElement);
	const fallback = FALLBACK[scheme()];
	const resolved = SERIES_TOKENS.map(name => {
		const value = style.getPropertyValue(name).trim();
		if (value) return value;
		return name in fallback ? fallback[name as TokenName] : fallback["--sc-text-muted"];
	});
	return resolved.filter((color, index) => resolved.indexOf(color) === index);
}

/** `#rgb` / `#rrggbb` → `rgba(…, alpha)`; any other CSS color is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
	const hex = color.startsWith("#") ? color.slice(1) : "";
	const full =
		hex.length === 3
			? [...hex].map(digit => digit + digit).join("")
			: hex.length === 6 || hex.length === 8
				? hex.slice(0, 6)
				: "";
	if (!/^[0-9a-f]{6}$/i.test(full)) return color;
	const value = Number.parseInt(full, 16);
	return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export function chartTheme() {
	return {
		text: token("--sc-text"),
		muted: token("--sc-text-muted"),
		grid: token("--sc-divider"),
		accent: token("--sc-accent"),
		success: token("--sc-success"),
		warning: token("--sc-warning"),
		error: token("--sc-danger"),
	};
}

/** Tick/legend font: the UI sans stack at the caption step, scaled with the user font size. */
function chartFont(): { family: string; size: number } {
	const style = getComputedStyle(document.documentElement);
	const base = Number.parseFloat(style.getPropertyValue("--gui-font-size")) || 15;
	return {
		family: style.getPropertyValue("--sc-font-sans").trim() || "system-ui, sans-serif",
		size: Math.round((base * 12) / 15),
	};
}

/** Shared axis/legend/tooltip defaults merged into each chart's options. */
export function baseChartOptions(): {
	scales: {
		x: {
			grid: { color: string };
			border: { color: string };
			ticks: { color: string; maxRotation: number; font: { size: number; family: string } };
		};
		y: {
			grid: { color: string };
			border: { display: boolean };
			ticks: { color: string; font: { size: number; family: string } };
			beginAtZero: boolean;
		};
	};
	plugins: {
		legend: {
			labels: {
				color: string;
				boxWidth: number;
				boxHeight: number;
				usePointStyle: boolean;
				font: { size: number; family: string };
			};
		};
		tooltip: {
			backgroundColor: string;
			titleColor: string;
			bodyColor: string;
			borderColor: string;
			borderWidth: number;
			padding: number;
			cornerRadius: number;
			titleFont: { size: number; family: string; weight: number };
			bodyFont: { size: number; family: string };
		};
	};
	maintainAspectRatio: boolean;
	responsive: boolean;
} {
	const theme = chartTheme();
	const font = chartFont();
	return {
		maintainAspectRatio: false,
		responsive: true,
		scales: {
			x: {
				grid: { color: theme.grid },
				border: { color: token("--sc-border-subtle") },
				ticks: { color: theme.muted, maxRotation: 0, font },
			},
			y: {
				beginAtZero: true,
				grid: { color: theme.grid },
				border: { display: false },
				ticks: { color: theme.muted, font },
			},
		},
		plugins: {
			legend: { labels: { color: theme.muted, boxWidth: 8, boxHeight: 8, usePointStyle: true, font } },
			tooltip: {
				backgroundColor: token("--sc-elevated"),
				titleColor: theme.text,
				bodyColor: token("--sc-text-secondary"),
				borderColor: token("--sc-border-subtle"),
				borderWidth: 1,
				padding: 8,
				cornerRadius: 8,
				titleFont: { ...font, weight: 600 },
				bodyFont: font,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Theme change subscription
// ---------------------------------------------------------------------------

let themeVersion = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let media: MediaQueryList | null = null;

function bump(): void {
	themeVersion++;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		if (typeof MutationObserver === "function") {
			observer = new MutationObserver(bump);
			observer.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ["data-theme", "style", "class", "lang"],
			});
		}
		if (typeof window.matchMedia === "function") {
			media = window.matchMedia("(prefers-color-scheme: light)");
			media.addEventListener("change", bump);
		}
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		observer?.disconnect();
		observer = null;
		media?.removeEventListener("change", bump);
		media = null;
	};
}

/** Changes whenever the root theme changes; key chart views on it so canvases repaint with fresh tokens. */
export function useChartThemeKey(): number {
	return useSyncExternalStore(
		subscribe,
		() => themeVersion,
		() => 0,
	);
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** Compact number formatting for ticks and tables (1.2k / 3.4M / $0.02). */
export function compact(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return `${Math.round(value * 10) / 10}`;
}

export function formatUsd(value: number): string {
	if (value === 0) return "$0";
	return formatCost(value, Math.abs(value) < 0.01 ? 4 : 2);
}

export function formatMs(value: number | null): string {
	if (value === null || !Number.isFinite(value)) return "—";
	if (value < 1000) return `${Math.round(value)}ms`;
	return `${(value / 1000).toFixed(1)}s`;
}

/** Bucket timestamps → short labels (HH:mm for ≤24h ranges, MMM d otherwise). */
export function bucketLabels(timestamps: number[]): string[] {
	const span = timestamps.length > 1 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
	const short = span <= 26 * 3600_000;
	return timestamps.map(ts => {
		const date = new Date(ts);
		return short
			? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
			: date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	});
}
