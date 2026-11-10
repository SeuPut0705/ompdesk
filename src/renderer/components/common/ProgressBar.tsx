/**
 * ProgressBar — a horizontal bar in one of two tones, or one bar split into shares.
 *
 * - `meter` (default): how full something is (context, quota, budget), with
 *   threshold coloring: green < 0.75, yellow < 0.9, red >= 0.9.
 * - `progress`: how far a task got (a download, an install). Always the
 *   accent, since nearing 100% is good news, never a warning.
 *
 * Without a `value` the bar is indeterminate: a sliding accent segment, no
 * fraction claimed to assistive tech and no percent text. It stops sliding
 * under prefers-reduced-motion (global rule).
 *
 * `segments` draws several shares of one whole side by side (a context window by category, findings by severity, a
 * plan's steps by state): each a `value` in any unit, painted with a status `tone` (StatusDot's) or, for data shares
 * that are not states, an explicit `color`, and named by its `label` (its hover title, and the bar's accessible
 * name lists every share). The shares fill the bar unless `total` says what the full bar stands for (a context
 * window with room left). The bar is an image to assistive tech, not a progressbar: it shows how a whole divides, not
 * how far one thing got. The words beside it (a legend, a count) stay the caller's; no percent text is added.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";
import { STATUS_TONE_FILL, type StatusTone } from "./StatusDot";

export type ProgressBarTone = "meter" | "progress";

/** One share of a segmented bar: a status `tone`, or a `color` for a data share that is no state. */
export type ProgressSegment = { value: number; label: string } & (
	| { tone: StatusTone; color?: never }
	| { color: string; tone?: never }
);

interface ProgressBarFrame {
	/** Optional label rendered to the left of the bar. */
	label?: string;
	/** Optional value text rendered to the right (a single bar defaults to percent; `""` shows none). */
	valueText?: string;
	/** Accessible name of the bar when no visible `label` names it. */
	ariaLabel?: string;
	/** Track height in px. */
	height?: number;
	className?: string;
}

export interface ProgressBarProps extends ProgressBarFrame {
	/** Fill fraction, clamped to 0..1; omit for an indeterminate bar. */
	value?: number;
	tone?: ProgressBarTone;
	/** Override the tone's coloring with an explicit CSS color (data shares, not state). */
	color?: string;
	segments?: never;
	total?: never;
}

export interface SegmentedProgressBarProps extends ProgressBarFrame {
	segments: readonly ProgressSegment[];
	/** What the full bar stands for, when the shares do not fill it; defaults to their sum. */
	total?: number;
	value?: never;
	tone?: never;
	color?: never;
}

function thresholdColor(value: number): string {
	if (value >= 0.9) return "var(--sc-danger)";
	if (value >= 0.75) return "var(--sc-warning)";
	return "var(--sc-success)";
}

const TRACK = "min-w-0 flex-1 overflow-hidden rounded-full bg-(--sc-surface-3)";

function Frame({
	label,
	text,
	className,
	children,
}: {
	label?: string;
	text?: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={cx("flex items-center gap-2", className)}>
			{label && (
				<span className="shrink-0 text-sc-2xs font-medium tracking-wide text-(--sc-text-muted) uppercase">
					{label}
				</span>
			)}
			{children}
			{text && <span className="shrink-0 text-sc-2xs tabular-nums text-(--sc-text-muted)">{text}</span>}
		</div>
	);
}

function SegmentedBar({
	segments,
	total,
	label,
	valueText,
	ariaLabel,
	height,
	className,
}: ProgressBarFrame & { segments: readonly ProgressSegment[]; total?: number }) {
	const shares = segments.filter(segment => Number.isFinite(segment.value) && segment.value > 0);
	const sum = shares.reduce((acc, segment) => acc + segment.value, 0);
	const room = Math.max(0, (total ?? sum) - sum);
	const name = shares.map(segment => `${segment.label} ${segment.value}`).join(", ");
	return (
		<Frame className={className} label={label} text={valueText}>
			<div
				aria-label={[ariaLabel ?? label, name].filter(Boolean).join(": ")}
				className={cx(TRACK, "flex gap-px")}
				data-progress-segments=""
				role="img"
				style={{ height }}
			>
				{shares.map((segment, index) => (
					<span
						className={cx("h-full min-w-0.5", segment.tone && STATUS_TONE_FILL[segment.tone])}
						key={`${segment.label}-${index}`}
						// Shares grow from a zero basis, so the 1 px gaps never push the total past the track.
						style={{ flex: `${segment.value} 1 0`, backgroundColor: segment.color }}
						title={segment.label}
					/>
				))}
				{room > 0 && <span aria-hidden style={{ flex: `${room} 1 0` }} />}
			</div>
		</Frame>
	);
}

export function ProgressBar(props: ProgressBarProps | SegmentedProgressBarProps) {
	const { segments, total, value, tone = "meter", color, height = 6, ...frame } = props;
	if (segments) return <SegmentedBar {...frame} height={height} segments={segments} total={total} />;
	const { label, valueText, ariaLabel, className } = frame;
	const indeterminate = value === undefined;
	const clamped = indeterminate ? 0 : Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
	const fill = color ?? (tone === "progress" || indeterminate ? "var(--sc-accent)" : thresholdColor(clamped));
	const text = indeterminate ? "" : (valueText ?? `${Math.round(clamped * 100)}%`);

	return (
		<Frame className={className} label={label} text={text}>
			<div
				aria-label={ariaLabel ?? label}
				aria-valuemax={indeterminate ? undefined : 1}
				aria-valuemin={indeterminate ? undefined : 0}
				aria-valuenow={indeterminate ? undefined : Number(clamped.toFixed(3))}
				className={TRACK}
				role="progressbar"
				style={{ height }}
			>
				{indeterminate ? (
					<div className="omp-indeterminate-progress h-full rounded-full" style={{ backgroundColor: fill }} />
				) : (
					// scaleX from the left edge, not `width`: the fill's size change is a compositor transform, not a layout.
					<div
						className="h-full origin-left transition-transform duration-(--sc-duration-med) ease-(--sc-ease-standard)"
						style={{ transform: `scaleX(${clamped})`, backgroundColor: fill }}
					/>
				)}
			</div>
		</Frame>
	);
}
