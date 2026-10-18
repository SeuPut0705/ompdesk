/**
 * Spinner — indeterminate progress for a wait under ~10s with nothing better
 * to show (prefer a skeleton for content, ProgressBar when progress is known).
 * Neutral (text-muted) on its own; `inheritColor` takes the surrounding text
 * color for the ring and its label, e.g. inside a Button or a Banner. Pass
 * `label` instead of a sibling text node: the label is what gets announced.
 * Always announced as status.
 *
 * Still by default: a wait for content (a probe, a list, a detail) is a hollow ring that never turns, because
 * nothing may wait on a spinner (AGENTS.md › No loading screens; prefer a snapshot or a `Skeleton`). Only feedback
 * for an action the person just started (a button, an icon button, a row action) passes `spin`.
 *
 * The rotation runs on an HTML wrapper, not the <svg>: Chromium animates an
 * SVG element's transform on the main thread (style and paint every frame for
 * as long as a run shows the spinner), an HTML box's on the compositor.
 */

import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

const SIZES = {
	sm: { box: 12, stroke: 2.5 },
	md: { box: 16, stroke: 2.5 },
	lg: { box: 26, stroke: 3 },
} as const;

export type SpinnerSize = keyof typeof SIZES;

export interface SpinnerProps {
	size?: SpinnerSize;
	/** Optional text rendered beside the spinner. */
	label?: string;
	/** Turn the ring: feedback for an action the person just started, never for content that is on its way. */
	spin?: boolean;
	/** Use the surrounding text color instead of text-muted. */
	inheritColor?: boolean;
	className?: string;
}

export function Spinner({ size = "md", label, spin = false, inheritColor, className }: SpinnerProps) {
	const t = useT();
	const { box, stroke } = SIZES[size];
	const svg = (
		<span
			aria-hidden="true"
			className={cx("inline-flex", spin && "animate-spin", !inheritColor && "text-(--sc-text-muted)")}
		>
			<svg fill="none" height={box} viewBox="0 0 24 24" width={box}>
				<circle
					cx="12"
					cy="12"
					r="9.5"
					stroke="currentColor"
					strokeOpacity={spin ? 0.22 : 0.5}
					strokeWidth={stroke}
				/>
				{spin && (
					<path
						d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5"
						stroke="currentColor"
						strokeLinecap="round"
						strokeWidth={stroke}
					/>
				)}
			</svg>
		</span>
	);

	if (!label) {
		return (
			<span className={className ?? "inline-flex"} role="status" aria-label={t("common.loading")}>
				{svg}
			</span>
		);
	}

	return (
		<span
			className={cx(
				"inline-flex items-center gap-2 text-sc-sm",
				!inheritColor && "text-(--sc-text-muted)",
				className,
			)}
			role="status"
		>
			{svg}
			<span>{label}</span>
		</span>
	);
}
