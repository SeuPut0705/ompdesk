/**
 * Card — the bordered frame around a piece of content inside a surface: a code box, a result, a table, a group of
 * fields, a quoted file, a featured provider, a docked row. The subtle border and four choices only:
 * - `radius`: `md` (default) a box inside a block; `lg` a block of its own (a provider's card, a custom message, a
 *   setup step, a usage report).
 * - `padding`: `none` for content that draws its own rows or header (a `<ul>` with dividers, a table, a picture),
 *   `sm` a line's inset, `md` default, `row` one roomy line of text and controls (px 16, py 12), `lg` a roomy block.
 * - `surface`: `none` transparent (default); `1` the figure ground; `2` quoted or read-only content; `code` a code or
 *   output box (`--sc-code-bg`); `elevated` a row docked over the transcript (`--sc-elevated`).
 * - `as`: the element (`div` default; `section`, `article`, `li`, `ul`, `dl`, `span`, `pre` for the frame that is the
 *   list, the definition list or the output itself). `button` makes the whole card one pressable target (a featured
 *   choice that opens its flow): `type="button"`, the hover wash and the kit's focus ring, dimmed while disabled. A card
 *   holding several controls is never a button; put the controls inside a `div` card.
 *
 * It never takes a shadow or a status colour: a condition is a `Banner` or `InlineNotice`, a floating layer is a
 * `Popover`. `className` lays out what is inside (flex, gap, max height, overflow, a grid), never repaints the frame.
 * Every other attribute (`ref`, `role`, `aria-*`, `data-*`, handlers) reaches the element.
 */

import { type ComponentPropsWithRef, createElement } from "react";
import { cx } from "../../lib/format";

export type CardElement = "div" | "section" | "article" | "li" | "ul" | "dl" | "span" | "pre" | "button";
export type CardPadding = "none" | "sm" | "md" | "row" | "lg";
export type CardSurface = "none" | "1" | "2" | "code" | "elevated";
export type CardRadius = "md" | "lg";

const PADDING: Record<CardPadding, string> = {
	none: "",
	sm: "px-3 py-2",
	md: "p-3",
	row: "px-4 py-3",
	lg: "p-4",
};

const SURFACE: Record<CardSurface, string> = {
	none: "",
	"1": "bg-(--sc-surface-1)",
	"2": "bg-(--sc-surface-2)",
	code: "bg-(--sc-code-bg)",
	elevated: "bg-(--sc-elevated)",
};

const RADIUS: Record<CardRadius, string> = {
	md: "rounded-(--sc-radius-md)",
	lg: "rounded-(--sc-radius-lg)",
};

const PRESSABLE =
	"text-left transition-colors duration-(--sc-duration-fast) ease-(--sc-ease-standard) enabled:hover:border-(--sc-border) enabled:hover:bg-(--sc-hover) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-offset-(--sc-focus-offset) focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50";

export type CardProps<E extends CardElement = "div"> = {
	as?: E;
	padding?: CardPadding;
	surface?: CardSurface;
	radius?: CardRadius;
	className?: string;
} & Omit<ComponentPropsWithRef<E>, "as" | "className">;

export function Card<E extends CardElement = "div">({
	as,
	padding = "md",
	surface = "none",
	radius = "md",
	className,
	...rest
}: CardProps<E>) {
	const pressable = as === "button";
	// createElement, not a JSX tag: the element is one of several intrinsics, and JSX would check `rest` (whose `ref`
	// is the chosen element's) against all of them at once.
	return createElement(as ?? "div", {
		className: cx(
			"border border-(--sc-border-subtle)",
			RADIUS[radius],
			PADDING[padding],
			SURFACE[surface],
			pressable && PRESSABLE,
			className,
		),
		"data-card": "",
		type: pressable ? "button" : undefined,
		...rest,
	});
}
