/**
 * Color math shared by the theme builder (theme-builder.ts), the contrast and
 * distinctness tests and the picker previews. Pure functions on `#rrggbb` /
 * `rgba(r, g, b, a)` strings; no DOM.
 */

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
	const raw = hex.trim();
	const full = /^#[0-9a-f]{3}$/i.test(raw) ? `#${[...raw.slice(1)].map(c => c + c).join("")}` : raw;
	if (!/^#[0-9a-f]{6}$/i.test(full)) throw new Error(`Not a #rrggbb color: ${hex}`);
	return [1, 3, 5].map(i => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

export function rgbToHex([r, g, b]: Rgb): string {
	return `#${[r, g, b]
		.map(c =>
			Math.round(Math.min(255, Math.max(0, c)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/** `#rrggbb` → `rgba(r, g, b, alpha)` in the spelling the token maps use. */
export function withAlpha(hex: string, alpha: number): string {
	const [r, g, b] = hexToRgb(hex);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Linear blend: `t` = 0 is `a`, 1 is `b`. */
export function mix(a: string, b: string, t: number): string {
	const x = hexToRgb(a);
	const y = hexToRgb(b);
	return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** A color as the page paints it: `rgba()` is composited over `base`, hex passes through. */
export function flatten(color: string, base: string): string {
	if (color.startsWith("#")) return color;
	const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(color);
	if (!match) throw new Error(`Unsupported color: ${color}`);
	const alpha = Number(match[4]);
	const under = hexToRgb(base);
	return rgbToHex([1, 2, 3].map(i => Number(match[i]) * alpha + under[i - 1]! * (1 - alpha)) as unknown as Rgb);
}

function channel(value: number): number {
	const c = value / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance. */
export function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
	const x = luminance(a);
	const y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** CIE Lab (D65) of a `#rrggbb` color. */
export function toLab(hex: string): readonly [number, number, number] {
	const [r, g, b] = hexToRgb(hex).map(channel) as [number, number, number];
	const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
	const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
	const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
	const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
	return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 color difference; about 2.3 is one just-noticeable step, above ~10 two colors read as different. */
export function deltaE(a: string, b: string): number {
	const p = toLab(a);
	const q = toLab(b);
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Hue in degrees (0-360) of a `#rrggbb` color. */
export function hue(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(c => c / 255) as [number, number, number];
	const max = Math.max(r, g, b);
	const delta = max - Math.min(r, g, b);
	if (delta === 0) return 0;
	const h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
	return (h * 60 + 360) % 360;
}
