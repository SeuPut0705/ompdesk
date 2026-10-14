/**
 * ProgressBar — a horizontal bar in one of two tones.
 *
 * - `meter` (default): how full something is (context, quota, budget), with
 *   threshold coloring: green < 0.75, yellow < 0.9, red >= 0.9.
 * - `progress`: how far a task got (a download, an install). Always the
 *   accent, since nearing 100% is good news, never a warning.
 *
 * Without a `value` the bar is indeterminate: a sliding accent segment, no
 * fraction claimed to assistive tech and no percent text. It stops sliding
 * under prefers-reduced-motion (global rule).
 */

import { cx } from "../../lib/format";

export type ProgressBarTone = "meter" | "progress";

export interface ProgressBarProps {
	/** Fill fraction, clamped to 0..1; omit for an indeterminate bar. */
	value?: number;
	tone?: ProgressBarTone;
	/** Optional label rendered to the left of the bar. */
	label?: string;
	/** Optional value text rendered to the right (defaults to percent; `""` shows none). */
	valueText?: string;
	/** Accessible name of the bar when no visible `label` names it. */
	ariaLabel?: string;
	/** Override the tone's coloring with an explicit CSS color (data shares, not state). */
	color?: string;
	/** Track height in px. */
	height?: number;
	className?: string;
}

function thresholdColor(value: number): string {
	if (value >= 0.9) return "var(--sc-danger)";
	if (value >= 0.75) return "var(--sc-warning)";
	return "var(--sc-success)";
}

export function ProgressBar({
	value,
	tone = "meter",
	label,
	valueText,
	ariaLabel,
	color,
	height = 6,
	className,
}: ProgressBarProps) {
	const indeterminate = value === undefined;
	const clamped = indeterminate ? 0 : Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
	const fill = color ?? (tone === "progress" || indeterminate ? "var(--sc-accent)" : thresholdColor(clamped));
	const text = indeterminate ? "" : (valueText ?? `${Math.round(clamped * 100)}%`);

	return (
		<div className={cx("flex items-center gap-2", className)}>
			{label && (
				<span className="shrink-0 text-sc-2xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
					{label}
				</span>
			)}
			<div
				aria-label={ariaLabel ?? label}
				aria-valuemax={indeterminate ? undefined : 1}
				aria-valuemin={indeterminate ? undefined : 0}
				aria-valuenow={indeterminate ? undefined : Number(clamped.toFixed(3))}
				className="min-w-0 flex-1 overflow-hidden rounded-full bg-(--sc-surface-3)"
				role="progressbar"
				style={{ height }}
			>
				{indeterminate ? (
					<div className="omp-indeterminate-progress h-full rounded-full" style={{ backgroundColor: fill }} />
				) : (
					<div
						className="h-full rounded-full transition-[width] duration-(--sc-duration-med) ease-out"
						style={{ width: `${clamped * 100}%`, backgroundColor: fill }}
					/>
				)}
			</div>
			{text && <span className="shrink-0 text-sc-2xs tabular-nums text-(--sc-text-muted)">{text}</span>}
		</div>
	);
}
