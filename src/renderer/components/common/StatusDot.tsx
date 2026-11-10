/**
 * StatusDot — a small coloured dot and the word for the state it marks ("● Online", "● Running"). Colour is never the
 * only cue: the word is always there, beside the dot by default, or with `labelHidden` read by screen readers and
 * shown as the hover title, for a dense row whose own text or icon already tells sighted readers the state (a device
 * avatar's corner, a file's git mark). A state drawn as a pill with its word inside is a `Badge` with `dot`; a bare dot
 * with no word is not allowed.
 *
 * `tone` carries the meaning: `success` done or reachable, `warning` needs a look, `danger` failed or gone, `info`
 * informational, `neutral` idle or pending, `working` going on now (the accent, pulsing unless `pulse={false}`).
 * `pulse` on another tone marks a live state of that tone; reduced motion holds it still (global rule). The word takes
 * the surrounding font size and colour, so the dot fits any row; `size` `md` draws the 8 px dot of a roomier row.
 */

import { cx } from "../../lib/format";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral" | "working";

/** Each tone's fill; ProgressBar's segments paint with the same tones. */
export const STATUS_TONE_FILL: Record<StatusTone, string> = {
	success: "bg-(--sc-success)",
	warning: "bg-(--sc-warning)",
	danger: "bg-(--sc-danger)",
	info: "bg-(--sc-info)",
	neutral: "bg-(--sc-text-muted)",
	working: "bg-(--sc-accent)",
};

export interface StatusDotProps {
	tone: StatusTone;
	/** The state in words ("Online", "Running"). */
	label: string;
	/** Read by screen readers and shown as the title only: for a row whose text or icon already says the state. */
	labelHidden?: boolean;
	/** Pulse the dot (live); defaults to on for `working`. */
	pulse?: boolean;
	/** `sm` 6 px (default), `md` 8 px. */
	size?: "sm" | "md";
	className?: string;
}

export function StatusDot({
	tone,
	label,
	labelHidden,
	pulse = tone === "working",
	size = "sm",
	className,
}: StatusDotProps) {
	return (
		<span
			className={cx("inline-flex min-w-0 items-center gap-1.5", className)}
			data-status-dot={tone}
			title={labelHidden ? label : undefined}
		>
			<span
				aria-hidden
				className={cx(
					"shrink-0 rounded-full",
					size === "md" ? "size-2" : "size-1.5",
					STATUS_TONE_FILL[tone],
					pulse && "omp-pulse-dot",
				)}
			/>
			<span className={labelHidden ? "sr-only" : undefined}>{label}</span>
		</span>
	);
}
