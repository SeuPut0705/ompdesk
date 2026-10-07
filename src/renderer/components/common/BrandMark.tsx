/**
 * The ompdesk mark, the interlaced knot — the only in-app rendering of the logo
 * (geometry in src/shared/brand-mark.ts, the same paths as the app icon and tray).
 * Sizes ≤ BRAND_MARK.smallMaxPx draw the simplified knot (heavier strands, no
 * ring); larger sizes draw the full emblem.
 *
 * Usage:
 * - `variant="color"` (default): person strand in currentColor, agent strand in
 *   the theme accent; use on app surfaces (sidebar, empty states, onboarding).
 * - `variant="mono"`: both strands in currentColor; use inside colored or busy
 *   contexts where a second hue would compete.
 * - `variant="tile"`: the fixed app-icon tile (platinum + gold on ink, same in
 *   light and dark); use where the mark stands in for the app itself.
 * Decorative by default; pass `title` when the mark is the only thing naming
 * the app (it then gets role="img" and that accessible name).
 */
import { useId } from "react";
import { BRAND_MARK, knotFormForSize } from "../../../shared/brand-mark";
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
	// Mask, clip and gradient ids must be unique per instance; useId's output is not a valid bare URL fragment.
	const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
	const knot = BRAND_MARK[knotFormForSize(size)];
	const tile = variant === "tile";
	const ink = tile ? `url(#bp${uid})` : "currentColor";
	const accent = tile ? `url(#bg${uid})` : variant === "mono" ? "currentColor" : ACCENT_VAR;
	const { metal } = BRAND_MARK;
	const gradient = (id: string, stops: typeof metal.platinum | typeof metal.gold) => (
		<linearGradient
			id={id}
			gradientUnits="userSpaceOnUse"
			x1={metal.from[0]}
			y1={metal.from[1]}
			x2={metal.to[0]}
			y2={metal.to[1]}
		>
			{stops.map(([offset, color]) => (
				<stop key={offset} offset={offset} stopColor={color} />
			))}
		</linearGradient>
	);
	const strand = (color: string) => (
		<path d={knot.strand} stroke={color} strokeWidth={knot.strokeWidth} mask={`url(#bm${uid})`} />
	);
	const glyph = (
		<>
			{knot.ring && (
				<>
					<circle r={knot.ring.ink.r} stroke={ink} strokeWidth={knot.ring.ink.width} />
					<circle r={knot.ring.accent.r} stroke={accent} strokeWidth={knot.ring.accent.width} />
				</>
			)}
			{strand(ink)}
			<g transform="rotate(180)">{strand(accent)}</g>
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
			<defs>
				<clipPath id={`bx${uid}`}>
					<circle cx={knot.under.cx} cy={0} r={knot.under.r} />
				</clipPath>
				<mask id={`bm${uid}`} maskUnits="userSpaceOnUse" x={-300} y={-300} width={600} height={600}>
					<rect x={-300} y={-300} width={600} height={600} fill="#fff" />
					<g clipPath={`url(#bx${uid})`}>
						<path d={knot.strand} transform="rotate(180)" stroke="#000" strokeWidth={knot.cutWidth} />
					</g>
					{knot.groove && <path d={knot.groove.d} stroke="#000" strokeWidth={knot.groove.width} />}
				</mask>
				{tile && gradient(`bp${uid}`, metal.platinum)}
				{tile && gradient(`bg${uid}`, metal.gold)}
			</defs>
			{tile ? (
				<>
					<rect
						x={-256}
						y={-256}
						width={512}
						height={512}
						rx={BRAND_MARK.tile.radius}
						fill={BRAND_MARK.tile.background}
					/>
					<g transform={`scale(${BRAND_MARK.tile.glyphScale})`}>{glyph}</g>
				</>
			) : (
				glyph
			)}
		</svg>
	);
}
