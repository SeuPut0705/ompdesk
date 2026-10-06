/**
 * Badge — a short, non-interactive status or count label (1–2 words).
 *
 * Variants carry meaning, not decoration: `success` done/ok, `warning`
 * needs attention, `error` failed, `info` informational, `accent` the
 * active mode (Plan, Goal), `default` neutral counts and tags, `muted`
 * de-emphasised metadata. Use `dot` (+ `pulse` while live) for running
 * state; the text must still say the state — color is never the only cue.
 * Not a button: clickable chips are Buttons (size sm) or ListRows.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";

export type BadgeVariant = "default" | "accent" | "success" | "warning" | "error" | "info" | "muted";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
	default: "bg-(--sc-surface-3) text-(--sc-text-secondary)",
	accent: "bg-(--sc-accent-soft) text-(--sc-accent)",
	success: "bg-(--sc-success-soft) text-(--sc-success)",
	warning: "bg-(--sc-warning-soft) text-(--sc-warning)",
	error: "bg-(--sc-danger-soft) text-(--sc-danger)",
	info: "bg-(--sc-info-soft) text-(--sc-info)",
	muted: "bg-transparent text-(--sc-text-muted)",
};

const DOT_CLASSES: Record<BadgeVariant, string> = {
	default: "bg-(--sc-text-muted)",
	accent: "bg-(--sc-accent)",
	success: "bg-(--sc-success)",
	warning: "bg-(--sc-warning)",
	error: "bg-(--sc-danger)",
	info: "bg-(--sc-info)",
	muted: "bg-(--sc-text-subtle)",
};

export interface BadgeProps {
	variant?: BadgeVariant;
	/** Show a small colored dot before the label. */
	dot?: boolean;
	/** Pulse the dot (e.g. live/running states). */
	pulse?: boolean;
	className?: string;
	children: ReactNode;
}

export function Badge({ variant = "default", dot, pulse, className, children }: BadgeProps) {
	return (
		<span
			className={cx(
				"inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-sc-2xs font-medium whitespace-nowrap",
				VARIANT_CLASSES[variant],
				className,
			)}
		>
			{dot && (
				<span aria-hidden className={cx("size-1.5 rounded-full", pulse && "omp-pulse-dot", DOT_CLASSES[variant])} />
			)}
			{children}
		</span>
	);
}
