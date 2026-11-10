/**
 * Badge — a short, non-interactive status or count label (1–2 words).
 *
 * Variants carry meaning, not decoration: `success` done/ok, `warning`
 * needs attention, `error` failed, `info` informational, `accent` the
 * active mode (Plan, Goal), `default` neutral counts and tags, `muted`
 * de-emphasised metadata. Use `dot` (+ `pulse` while live) for running
 * state; the text must still say the state — color is never the only cue.
 * Not a button: clickable chips are Buttons (size sm) or ListRows.
 *
 * `size`: `sm` 20 px (default), `xs` 16 px for a mark inside a dense line (a folded header's waiting count, an
 * island's count). An icon child is drawn at 12 px. `truncate` lets a long badge (a path, a note) shrink with its
 * row and end in an ellipsis instead of pushing the row wider; say the whole text elsewhere (a `Tooltip` around it).
 * DOM attributes (`data-*`, `title`, `aria-hidden`, `id`) reach the badge itself.
 */

import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/format";

export type BadgeVariant = "default" | "accent" | "success" | "warning" | "error" | "info" | "muted";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
	default: "bg-(--sc-surface-3) text-(--sc-text-secondary)",
	accent: "bg-(--sc-accent-soft) text-(--sc-accent-on-soft)",
	success: "bg-(--sc-success-soft) text-(--sc-success-on-soft)",
	warning: "bg-(--sc-warning-soft) text-(--sc-warning-on-soft)",
	error: "bg-(--sc-danger-soft) text-(--sc-danger-on-soft)",
	info: "bg-(--sc-info-soft) text-(--sc-info-on-soft)",
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

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children">, DataAttributes {
	variant?: BadgeVariant;
	/** Show a small colored dot before the label. */
	dot?: boolean;
	/** Pulse the dot (e.g. live/running states). */
	pulse?: boolean;
	/** `sm` 20 px (default), `xs` 16 px. */
	size?: "xs" | "sm";
	/** Shrink with the row and cut the text with an ellipsis. */
	truncate?: boolean;
	children: ReactNode;
}

export function Badge({
	variant = "default",
	dot,
	pulse,
	size = "sm",
	truncate,
	className,
	children,
	...rest
}: BadgeProps) {
	return (
		<span
			{...rest}
			className={cx(
				"inline-flex items-center rounded-full text-sc-2xs font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
				size === "xs" ? "h-4 gap-0.5 px-1" : "h-5 gap-1.5 px-2",
				truncate ? "max-w-full min-w-0" : "shrink-0",
				VARIANT_CLASSES[variant],
				className,
			)}
		>
			{dot && (
				<span
					aria-hidden
					className={cx("size-1.5 shrink-0 rounded-full", pulse && "omp-pulse-dot", DOT_CLASSES[variant])}
				/>
			)}
			{truncate ? <span className="min-w-0 truncate">{children}</span> : children}
		</span>
	);
}
