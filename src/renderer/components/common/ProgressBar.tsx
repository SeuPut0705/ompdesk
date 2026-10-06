/**
 * Horizontal meter with threshold coloring:
 * green < 0.75, yellow < 0.9, red >= 0.9.
 */

export interface ProgressBarProps {
	/** Fill fraction, clamped to 0..1. */
	value: number;
	/** Optional label rendered to the left of the bar. */
	label?: string;
	/** Optional value text rendered to the right (defaults to percent). */
	valueText?: string;
	/** Override automatic threshold coloring with an explicit CSS color. */
	color?: string;
	/** Track height in px. */
	height?: number;
	className?: string;
}

function thresholdColor(value: number): string {
	if (value >= 0.9) return "var(--omp-error)";
	if (value >= 0.75) return "var(--omp-warning)";
	return "var(--omp-success)";
}

export function ProgressBar({ value, label, valueText, color, height = 6, className }: ProgressBarProps) {
	const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
	const fill = color ?? thresholdColor(clamped);
	const text = valueText ?? `${Math.round(clamped * 100)}%`;

	return (
		<div className={`flex items-center gap-2 ${className ?? ""}`.trim()}>
			{label && (
				<span className="shrink-0 text-omp-xs font-medium tracking-wide text-(--omp-muted) uppercase">{label}</span>
			)}
			<div
				aria-valuemax={1}
				aria-valuemin={0}
				aria-valuenow={Number(clamped.toFixed(3))}
				className="min-w-0 flex-1 overflow-hidden rounded-full bg-(--omp-bg-tertiary)" // surface-ok: progress bar track
				role="progressbar"
				style={{ height }}
			>
				<div
					className="h-full rounded-full transition-[width] duration-300 ease-out"
					style={{ width: `${clamped * 100}%`, backgroundColor: fill }}
				/>
			</div>
			<span className="shrink-0 text-omp-xs tabular-nums text-(--omp-dim)">{text}</span>
		</div>
	);
}
