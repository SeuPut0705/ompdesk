/**
 * StatusDot — a small coloured dot and the word for the state it marks ("● Online", "● Running"). Colour is never the
 * only cue: the word is there, beside the dot by default, or with `labelHidden` for screen readers only, for a dense row
 * whose own text or icon already tells sighted readers the state (a device avatar's corner, a file's git mark). A state
 * drawn as a pill with its word inside is a `Badge` with `dot`.
 *
 * `decorative` draws the dot alone, hidden from assistive tech, for a row that already says the state in words (a work
 * board row whose meta reads "Running", a banner whose sentence says the agent drives): the one case without `label`.
 * It renders a single element, so `className` and DOM attributes land on the dot itself (an avatar's corner places it
 * with `absolute` and cuts it out with a `ring-2`).
 *
 * `tone` carries the meaning: `success` done or reachable, `warning` needs a look, `danger` failed or gone, `info`
 * informational, `neutral` idle or pending, `working` going on now (the accent, pulsing unless `pulse={false}`).
 * `pulse` on another tone marks a live state of that tone; reduced motion holds it still (global rule). `ring` draws
 * the dot hollow, outlined in its tone: a state of that tone not reached yet or under way (a cycle running, a step
 * queued). The word takes the surrounding font size and colour, so the dot fits any row; `labelClassName` styles the
 * word alone; `size` `md` draws the 8 px dot of a roomier row. No native `title` is added: pass `title` (or wrap it in a
 * `Tooltip`, which reaches touch and keyboard too) only where a hover should say more than the word.
 */

import type { HTMLAttributes } from "react";
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

const TONE_RING: Record<StatusTone, string> = {
	success: "shadow-[inset_0_0_0_1px_var(--sc-success)]",
	warning: "shadow-[inset_0_0_0_1px_var(--sc-warning)]",
	danger: "shadow-[inset_0_0_0_1px_var(--sc-danger)]",
	info: "shadow-[inset_0_0_0_1px_var(--sc-info)]",
	neutral: "shadow-[inset_0_0_0_1px_var(--sc-text-muted)]",
	working: "shadow-[inset_0_0_0_1px_var(--sc-accent)]",
};

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

interface StatusDotLook extends Omit<HTMLAttributes<HTMLSpanElement>, "children">, DataAttributes {
	tone: StatusTone;
	/** Pulse the dot (live); defaults to on for `working`. */
	pulse?: boolean;
	/** A hollow dot outlined in its tone. */
	ring?: boolean;
	/** `sm` 6 px (default), `md` 8 px. */
	size?: "sm" | "md";
}

export type StatusDotProps = StatusDotLook &
	(
		| {
				/** The state in words ("Online", "Running"). */
				label: string;
				/** Read by screen readers only: for a row whose text or icon already says the state. */
				labelHidden?: boolean;
				/** Classes for the word alone (a header's status word that hides on a narrow panel). */
				labelClassName?: string;
				decorative?: never;
		  }
		| {
				/** The dot alone, hidden from assistive tech: the row says the state in words. */
				decorative: true;
				label?: never;
				labelHidden?: never;
				labelClassName?: never;
		  }
	);

export function StatusDot({
	tone,
	label,
	labelHidden,
	labelClassName,
	decorative,
	pulse = tone === "working",
	ring,
	size = "sm",
	className,
	...rest
}: StatusDotProps) {
	const dot = cx(
		"shrink-0 rounded-full",
		size === "md" ? "size-2" : "size-1.5",
		ring ? TONE_RING[tone] : STATUS_TONE_FILL[tone],
		pulse && "omp-pulse-dot",
	);
	if (decorative) {
		return <span {...rest} aria-hidden className={cx("inline-block", dot, className)} data-status-dot={tone} />;
	}
	return (
		<span {...rest} className={cx("inline-flex min-w-0 items-center gap-1.5", className)} data-status-dot={tone}>
			<span aria-hidden className={dot} />
			<span className={cx(labelHidden && "sr-only", labelClassName)}>{label}</span>
		</span>
	);
}
