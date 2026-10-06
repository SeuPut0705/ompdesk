/**
 * The seucode mark — the only in-app rendering of the logo (geometry in
 * src/shared/brand-mark.ts, the same paths as the app icon and tray).
 *
 * Usage:
 * - `variant="color"` (default): ink arc in currentColor, agent arc in the theme
 *   accent; use on app surfaces (empty states, about, onboarding).
 * - `variant="mono"`: both arcs in currentColor; use inside colored or busy
 *   contexts where a second hue would compete.
 * - `variant="tile"`: the fixed app-icon tile (same colors in light and dark);
 *   use where the mark stands in for the app itself.
 * Decorative by default; pass `title` when the mark is the only thing naming
 * the app (it then gets role="img" and that accessible name).
 */
import { BRAND_MARK } from "../../../shared/brand-mark";
import { cx } from "../../lib/format";

export type BrandMarkVariant = "color" | "mono" | "tile";

export interface BrandMarkProps {
	/** Rendered size in px (square). */
	size?: number;
	variant?: BrandMarkVariant;
	/** Accessible name; omit when adjacent text already names the app. */
	title?: string;
	className?: string;
}

const ACCENT_VAR = "var(--sc-accent, var(--omp-accent))";

export function BrandMark({ size = 16, variant = "color", title, className }: BrandMarkProps) {
	const tile = variant === "tile";
	const ink = tile ? BRAND_MARK.tile.ink : "currentColor";
	const accent = tile ? BRAND_MARK.tile.accent : variant === "mono" ? "currentColor" : ACCENT_VAR;
	const { cx: dotX, cy: dotY, r: dotR } = BRAND_MARK.accentTerminal;
	const glyph = (
		<>
			<path d={BRAND_MARK.ink} stroke={ink} strokeWidth={BRAND_MARK.strokeWidth} strokeLinecap="round" />
			<path d={BRAND_MARK.accent} stroke={accent} strokeWidth={BRAND_MARK.strokeWidth} />
			<circle cx={dotX} cy={dotY} r={dotR} fill={accent} />
		</>
	);
	const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true };

	return (
		<svg
			width={size}
			height={size}
			viewBox={BRAND_MARK.viewBox}
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className={cx("shrink-0", className)}
			{...a11y}
		>
			{tile ? (
				<>
					<rect width="32" height="32" rx={BRAND_MARK.tile.radius} fill={BRAND_MARK.tile.background} />
					<g transform={`translate(16 16) scale(${BRAND_MARK.tile.glyphScale}) translate(-16 -16)`}>{glyph}</g>
				</>
			) : (
				glyph
			)}
		</svg>
	);
}
