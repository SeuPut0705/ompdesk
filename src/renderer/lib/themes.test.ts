/**
 * Theme registry contract: every named theme must define the full
 * THEME_TOKEN_KEYS map — applyThemeByName writes tokens inline, so a missing
 * key silently falls back to whatever the previous theme left on <html>.
 */

import { describe, expect, it } from "vitest";
import { resolveTokenColor, THEME_TOKEN_KEYS, THEMES, type ThemeTokenKey, TRANSCRIPT_OVERLAY_VARS } from "./themes";

describe("theme registry", () => {
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

	it("carries picker metadata and a valid scheme", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			expect(theme.label.trim().length, `${name} label`).toBeGreaterThan(0);
			expect(theme.description?.trim().length ?? 0, `${name} description`).toBeGreaterThan(0);
			expect(["dark", "light"], `${name} scheme`).toContain(theme.scheme);
		}
	});

	it("keeps at least one light and one dark theme available", () => {
		const schemes = Object.values(THEMES).map(theme => theme.scheme);
		expect(schemes).toContain("light");
		expect(schemes).toContain("dark");
	});

	it("keeps the TUI overlay off chrome tokens", () => {
		const overlay = new Set(Object.values(TRANSCRIPT_OVERLAY_VARS));
		for (const chrome of ["--omp-accent", "--omp-sidebar-bg", "--omp-titlebar-bg", "--omp-btn-primary-bg"] as const) {
			expect(overlay.has(chrome), chrome).toBe(false);
		}
	});

	it("keeps small text, syntax, and diff lines readable on their actual surfaces", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			const color = (key: ThemeTokenKey) => resolveTokenColor(theme, key);
			const assertReadable = (foreground: ThemeTokenKey, background: ThemeTokenKey, base = "#ffffff") => {
				const ratio = contrast(color(foreground), composite(color(background), base));
				expect(ratio, `${name}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
			};
			for (const background of [
				"--omp-bg-primary",
				"--omp-sidebar-bg",
				"--omp-bg-elevated",
				"--omp-bg-tertiary",
			] as const) {
				for (const foreground of [
					"--omp-text",
					"--omp-text-secondary",
					"--omp-muted",
					"--omp-dim",
					"--omp-accent",
				] as const) {
					assertReadable(foreground, background);
				}
			}
			for (const key of THEME_TOKEN_KEYS.filter(key => key.startsWith("--omp-syntax-"))) {
				assertReadable(key, "--omp-code-bg");
			}
			assertReadable("--omp-diff-added", "--omp-diff-added-bg", color("--omp-code-bg"));
			assertReadable("--omp-diff-removed", "--omp-diff-removed-bg", color("--omp-code-bg"));
			assertReadable("--omp-btn-primary-text", "--omp-btn-primary-bg");
			assertReadable("--omp-btn-danger-text", "--omp-btn-danger-bg");
		}
	});

	it("keeps dark and light accents in the same hue family", () => {
		const delta = hueDelta(hexHue(THEMES.dark.tokens["--omp-accent"]), hexHue(THEMES.light.tokens["--omp-accent"]));
		expect(delta).toBeLessThan(30);
	});

	it("does not use purple for keyword, model, or custom-label roles", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			for (const key of ["--omp-syntax-keyword", "--omp-status-model", "--omp-custom-msg-label"] as const) {
				const hue = hexHue(theme.tokens[key]);
				expect(hue < 260 || hue > 320, `${name} ${key} hue ${hue}`).toBe(true);
			}
		}
	});
});

function composite(color: string, background: string): string {
	if (color.startsWith("#")) return color;
	const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
	if (!match) throw new Error(`Unsupported contrast color: ${color}`);
	const alpha = Number(match[4]);
	return `#${[1, 2, 3]
		.map((channel, i) => {
			const base = Number.parseInt(background.slice(1 + i * 2, 3 + i * 2), 16);
			return Math.round(Number(match[channel]) * alpha + base * (1 - alpha))
				.toString(16)
				.padStart(2, "0");
		})
		.join("")}`;
}

function contrast(foreground: string, background: string): number {
	const luminance = (hex: string) =>
		[0.2126, 0.7152, 0.0722].reduce((sum, weight, i) => {
			const channel = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
			return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
		}, 0);
	const a = luminance(foreground);
	const b = luminance(background);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hexHue(hex: string): number {
	const raw = hex.trim();
	if (!raw.startsWith("#") || (raw.length !== 7 && raw.length !== 4)) return -1;
	const n = raw.length === 4 ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}` : raw;
	const r = Number.parseInt(n.slice(1, 3), 16) / 255;
	const g = Number.parseInt(n.slice(3, 5), 16) / 255;
	const b = Number.parseInt(n.slice(5, 7), 16) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	if (max === min) return 0;
	const d = max - min;
	let h = 0;
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
	else if (max === g) h = ((b - r) / d + 2) * 60;
	else h = ((r - g) / d + 4) * 60;
	return h;
}

function hueDelta(a: number, b: number): number {
	if (a < 0 || b < 0) return 0;
	const d = Math.abs(a - b);
	return Math.min(d, 360 - d);
}
