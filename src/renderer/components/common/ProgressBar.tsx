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
 * under prefers-reduced-motion (global rule). `ariaValueText` says the value
 * in words to assistive tech when a fraction alone says too little ("838k
 * used, 162k left"). `animate={false}` draws each value at once, for a level
 * that changes every frame (a microphone's input); the fill still moves on
 * the compositor.
 *
 * `segments` draws several shares of one whole side by side (a context window by category, findings by severity, a
 * plan's steps by state): each a `value` in any unit, painted with a status `tone` (StatusDot's) or, for data shares
 * that are not states, an explicit `color`, and named by its `label` (its hover title, and the bar's accessible
 * name lists every share). The shares fill the bar unless `total` says what the full bar stands for (a context
 * window with room left). Such a bar is an image to assistive tech: it shows how a whole divides. Give it a `value`
 * as well (0..1, how full the whole is) and it is a progressbar of that value instead, its shares drawn for the eye
 * (the context window's fill, by category); `ariaValueText` names its value. The words beside it (a legend, a count)
 * stay the caller's; no percent text is added.
 *
 * `label` sits left of the bar in the small capitals of a field label; `labelCase="keep"` keeps the word as written
 * for a label that reads as text (a level's "Input"), and `labelClassName` gives it a fixed width so the bars of a
 * stack line up. The value text right of a single bar defaults to its percent, right-aligned in a fixed width so the
 * bar does not shift as the number grows.
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
	/** `upper` (default) the field label's small capitals; `keep` the label as written. */
	labelCase?: "upper" | "keep";
	/** Classes for the label alone (a fixed width that lines up a stack of bars). */
	labelClassName?: string;
	/** Optional value text rendered to the right (a single bar defaults to percent; `""` shows none). */
	valueText?: string;
	/** Accessible name of the bar when no visible `label` names it. */
	ariaLabel?: string;
	/** The value in words for assistive tech (`aria-valuetext`), on a bar that has a value. */
	ariaValueText?: string;
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
	/** Ease the fill between values (default); off for a value that changes every frame. */
	animate?: boolean;
	segments?: never;
	total?: never;
}

export interface SegmentedProgressBarProps extends ProgressBarFrame {
	segments: readonly ProgressSegment[];
	/** What the full bar stands for, when the shares do not fill it; defaults to their sum. */
	total?: number;
	/** How full the whole is (0..1): the bar is then a progressbar of this value, its shares drawn for the eye. */
	value?: number;
	tone?: never;
	color?: never;
	animate?: never;
}

function thresholdColor(value: number): string {
	if (value >= 0.9) return "var(--sc-danger)";
	if (value >= 0.75) return "var(--sc-warning)";
	return "var(--sc-success)";
}

/** The ARIA of a progressbar at `value` (0..1). */
function progressbarAria(value: number, name: string | undefined, valueText: string | undefined) {
	return {
		"aria-label": name,
		"aria-valuemax": 1,
		"aria-valuemin": 0,
		"aria-valuenow": Number(value.toFixed(3)),
		"aria-valuetext": valueText,
		role: "progressbar",
	} as const;
}

const TRACK = "min-w-0 flex-1 overflow-hidden rounded-full bg-(--sc-surface-3)";

function Frame({
	label,
	labelCase = "upper",
	labelClassName,
	text,
	textFixed,
	className,
	children,
}: {
	label?: string;
	labelCase?: "upper" | "keep";
	labelClassName?: string;
	text?: string;
	/** The text is a percent: right-aligned in the width of "100%". */
	textFixed?: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={cx("flex items-center gap-2", className)}>
			{label && (
				<span
					className={cx(
						"shrink-0 text-(--sc-text-muted)",
						labelCase === "upper" ? "text-sc-2xs font-medium tracking-wide uppercase" : "text-sc-xs",
						labelClassName,
					)}
				>
					{label}
				</span>
			)}
			{children}
			{text && (
				<span
					className={cx(
						"shrink-0 text-sc-2xs tabular-nums text-(--sc-text-muted)",
						textFixed && "min-w-[4ch] text-right",
					)}
				>
					{text}
				</span>
			)}
		</div>
	);
}

function SegmentedBar({
	segments,
	total,
	value,
	label,
	labelCase,
	labelClassName,
	valueText,
	ariaLabel,
	ariaValueText,
	height,
	className,
}: ProgressBarFrame & { segments: readonly ProgressSegment[]; total?: number; value?: number }) {
	const shares = segments.filter(segment => Number.isFinite(segment.value) && segment.value > 0);
	const sum = shares.reduce((acc, segment) => acc + segment.value, 0);
	const room = Math.max(0, (total ?? sum) - sum);
	const name = shares.map(segment => `${segment.label} ${segment.value}`).join(", ");
	const aria =
		value === undefined
			? ({ "aria-label": [ariaLabel ?? label, name].filter(Boolean).join(": "), role: "img" } as const)
			: progressbarAria(
					Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0,
					ariaLabel ?? label,
					ariaValueText,
				);
	return (
		<Frame className={className} label={label} labelCase={labelCase} labelClassName={labelClassName} text={valueText}>
			<div {...aria} className={cx(TRACK, "flex gap-px")} data-progress-segments="" style={{ height }}>
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
	const { segments, total, value, tone = "meter", color, animate = true, height = 6, ...frame } = props;
	if (segments) return <SegmentedBar {...frame} height={height} segments={segments} total={total} value={value} />;
	const { label, labelCase, labelClassName, valueText, ariaLabel, ariaValueText, className } = frame;
	const indeterminate = value === undefined;
	const clamped = indeterminate ? 0 : Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
	const fill = color ?? (tone === "progress" || indeterminate ? "var(--sc-accent)" : thresholdColor(clamped));
	const text = indeterminate ? "" : (valueText ?? `${Math.round(clamped * 100)}%`);

	return (
		<Frame
			className={className}
			label={label}
			labelCase={labelCase}
			labelClassName={labelClassName}
			text={text}
			textFixed={!indeterminate && valueText === undefined}
		>
			<div
				{...(indeterminate
					? { "aria-label": ariaLabel ?? label, role: "progressbar" as const }
					: progressbarAria(clamped, ariaLabel ?? label, ariaValueText))}
				className={TRACK}
				style={{ height }}
			>
				{indeterminate ? (
					<div className="omp-indeterminate-progress h-full rounded-full" style={{ backgroundColor: fill }} />
				) : (
					// scaleX from the left edge, not `width`: the fill's size change is a compositor transform, not a layout.
					<div
						className={cx(
							"h-full origin-left",
							animate && "transition-transform duration-(--sc-duration-med) ease-(--sc-ease-standard)",
						)}
						style={{ transform: `scaleX(${clamped})`, backgroundColor: fill }}
					/>
				)}
			</div>
		</Frame>
	);
}
