/**
 * The ompdesk mark, omp's π with an accent foot — the only in-app rendering of
 * the logo (geometry in src/shared/brand-mark.ts, the same paths as the app icon
 * and tray). Sizes ≤ BRAND_MARK.smallMaxPx draw the pixel-grid π (foot joined to
 * its leg); larger sizes draw the full mark (round terminals, foot set apart).
 *
 * Usage:
 * - `variant="color"` (default): π in currentColor, foot in the theme accent;
 *   use on app surfaces (sidebar, empty states, onboarding).
 * - `variant="mono"`: all of it in currentColor; use inside colored or busy
 *   contexts where a second hue would compete.
 * - `variant="tile"`: the fixed app-icon tile (platinum π, indigo foot on ink,
 *   same in light and dark); use where the mark stands in for the app itself.
 * Decorative by default; pass `title` when the mark is the only thing naming
 * the app (it then gets role="img" and that accessible name).
 */
import { useId } from "react";
import { BRAND_MARK, piFormForSize } from "../../../shared/brand-mark";
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
	// Gradient ids must be unique per instance; useId's output is not a valid bare URL fragment.
	const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
	const pi = BRAND_MARK[piFormForSize(size)];
	const { tile } = BRAND_MARK;
	const ink = variant === "tile" ? `url(#bi${uid})` : "currentColor";
	const accent = variant === "tile" ? `url(#ba${uid})` : variant === "mono" ? "currentColor" : ACCENT_VAR;
	const glyph = (
		<>
			<path d={pi.ink} fill={ink} />
			<path d={pi.accent} fill={accent} />
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
			{variant === "tile" ? (
				<>
					<defs>
						{(
							[
								[`bi${uid}`, tile.ink],
								[`ba${uid}`, tile.accent],
							] as const
						).map(([id, stops]) => (
							<linearGradient
								key={id}
								id={id}
								gradientUnits="userSpaceOnUse"
								x1={tile.from[0]}
								y1={tile.from[1]}
								x2={tile.to[0]}
								y2={tile.to[1]}
							>
								{stops.map(([offset, color]) => (
									<stop key={offset} offset={offset} stopColor={color} />
								))}
							</linearGradient>
						))}
					</defs>
					<rect x={-256} y={-256} width={512} height={512} rx={tile.radius} fill={tile.background} />
					<g transform={`scale(${tile.glyphScale})`}>{glyph}</g>
				</>
			) : (
				glyph
			)}
		</svg>
	);
}
