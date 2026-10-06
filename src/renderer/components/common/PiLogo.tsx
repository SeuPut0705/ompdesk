/**
 * The omp π logo as a proper SVG — a clean, geometric pi glyph with a curved
 * right foot, drawn with rounded strokes so it reads crisply from 12px favicon
 * to 512px app icon. Single source of truth for the mark; colored via `color`
 * (defaults to currentColor) and sized via `size`. `tile` wraps it in the
 * near-black rounded tile used for the app icon / sidebar badge.
 */
import { cx } from "../../lib/format";

export interface PiLogoProps {
	/** Glyph size in px (the SVG viewport is square). */
	size?: number;
	/** Glyph color (any CSS color); defaults to currentColor. */
	color?: string;
	/** Wrap the glyph in the near-black rounded tile (app-icon / badge form). */
	tile?: boolean;
	className?: string;
}

export function PiLogo({ size = 16, color, tile, className }: PiLogoProps) {
	const glyph = (
		<svg
			width={size}
			height={size}
			viewBox="0 0 32 32"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
			className="shrink-0"
		>
			<path d="M6.5 7.6 H25.5" stroke={color ?? "currentColor"} strokeWidth="3.3" strokeLinecap="round" />
			<path d="M11 7.6 V24.4" stroke={color ?? "currentColor"} strokeWidth="3.3" strokeLinecap="round" />
			<path
				d="M21 7.6 V18.2 C21 21.9 18.6 24.4 15.2 24.4"
				stroke={color ?? "currentColor"}
				strokeWidth="3.3"
				strokeLinecap="round"
			/>
		</svg>
	);

	if (!tile) return <span className={cx("inline-flex", className)}>{glyph}</span>;

	return (
		<span
			className={cx("inline-flex items-center justify-center rounded-md bg-[var(--omp-btn-primary-bg)]", className)}
			style={{ width: size, height: size }}
		>
			{/* Tile glyph is ~62% of the tile, drawn in the button-text color. */}
			<svg
				width={size * 0.62}
				height={size * 0.62}
				viewBox="0 0 32 32"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				aria-hidden="true"
			>
				<path d="M6.5 7.6 H25.5" stroke="var(--omp-btn-primary-text)" strokeWidth="3.3" strokeLinecap="round" />
				<path d="M11 7.6 V24.4" stroke="var(--omp-btn-primary-text)" strokeWidth="3.3" strokeLinecap="round" />
				<path
					d="M21 7.6 V18.2 C21 21.9 18.6 24.4 15.2 24.4"
					stroke="var(--omp-btn-primary-text)"
					strokeWidth="3.3"
					strokeLinecap="round"
				/>
			</svg>
		</span>
	);
}
