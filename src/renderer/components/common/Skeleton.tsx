/**
 * Skeleton — the shape of content that is still loading, so the layout does
 * not jump when it arrives. Prefer it to a Spinner wherever the final shape is
 * known (a list, a settings control); keep the Spinner for waits with no shape.
 * The shimmer stops under prefers-reduced-motion (global rule).
 *
 * - `Skeleton`: one hidden block; the caller sizes it with classes.
 * - `SkeletonRows`: a list placeholder (icon + text bar per row) announced
 *   once as status by `label`.
 */

import { cx } from "../../lib/format";

export function Skeleton({ className }: { className?: string }) {
	return <span aria-hidden className={cx("omp-skeleton block", className)} />;
}

export function SkeletonRows({
	label,
	widths,
	className,
}: {
	/** Screen-reader text for the whole placeholder ("Loading sessions…"). */
	label: string;
	/** One row per entry: the text bar's width in percent, varied so it reads as text. */
	widths: readonly number[];
	className?: string;
}) {
	return (
		<div aria-label={label} className={cx("space-y-px", className)} role="status">
			{widths.map((width, index) => (
				<div
					aria-hidden
					className="flex h-8 items-center gap-2.5 px-2.5"
					data-skeleton-row
					key={`${index}-${width}`}
				>
					<span className="omp-skeleton size-3.5 shrink-0 rounded-(--sc-radius-xs)" />
					<span className="omp-skeleton h-2.5 rounded-(--sc-radius-full)" style={{ width: `${width}%` }} />
				</div>
			))}
		</div>
	);
}
