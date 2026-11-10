/**
 * Card — the bordered frame around a piece of content inside a surface: a code box, a result, a table, a group of
 * fields, a quoted file. Medium radius, the subtle border, and two choices only: `padding` (`none` for content that
 * draws its own rows or header, `sm` a line's inset, `md` default, `lg` a roomy block) and `surface` (`none`
 * transparent, default; `1` the code and figure ground; `2` quoted or read-only content). It never takes a shadow or
 * a status colour: a condition is a `Banner` or `InlineNotice`, a floating layer is a `Popover`. `className` lays out
 * what is inside (flex, gap, max height, overflow), never repaints the frame. A list framed as a card wraps its
 * `<ul>` in one.
 */

import type { HTMLAttributes } from "react";
import { cx } from "../../lib/format";

export type CardPadding = "none" | "sm" | "md" | "lg";
export type CardSurface = "none" | "1" | "2";

const PADDING: Record<CardPadding, string> = {
	none: "",
	sm: "px-3 py-2",
	md: "p-3",
	lg: "p-4",
};

const SURFACE: Record<CardSurface, string> = {
	none: "",
	"1": "bg-(--sc-surface-1)",
	"2": "bg-(--sc-surface-2)",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
	padding?: CardPadding;
	surface?: CardSurface;
}

export function Card({ padding = "md", surface = "none", className, ...rest }: CardProps) {
	return (
		<div
			className={cx(
				"rounded-(--sc-radius-md) border border-(--sc-border-subtle)",
				PADDING[padding],
				SURFACE[surface],
				className,
			)}
			data-card=""
			{...rest}
		/>
	);
}
