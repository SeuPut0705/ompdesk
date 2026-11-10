/**
 * IconButton — an action shown as an icon alone.
 *
 * `label` is required: it is the accessible name and the tooltip text (pass
 * `shortcut` to show the chord too). Square hit targets on the control
 * scale — sm 28px (dense rows, dialog close), md 32px (toolbars, default),
 * lg 36px — with icons at 14 / 16 / 20px; the icon's own size is overridden.
 * `inline` is icon-sized (16px box, 14px icon) for a glyph that sits inside a line of text (a ✓ or ⚠ after a value
 * whose tooltip says more); it carries no hover wash, only the focus ring.
 * `pressed` makes it a toggle (aria-pressed). `loading` swaps the icon for a
 * still ring in the icon's place (same box, so nothing shifts), marks the button
 * busy and disables it — the one way a refresh or row action shows it is
 * running. It never turns: most refreshes start by themselves when a panel opens. Defaults to the ghost variant;
 * use `primary` only for the single main action of a surface (send). `tone` (`success`, `warning`, `danger`) colours
 * the icon with a status, hover included, in place of the variant's paint; the tooltip still says the state in words.
 * A button with no `onClick` is a glyph that explains itself: a tap on a touch screen opens its tooltip.
 */

import type { ComponentProps, ReactNode } from "react";
import { cx } from "../../lib/format";
import { type ButtonVariant, buttonPaint } from "./Button";
import { Spinner } from "./Spinner";
import { Tooltip, type TooltipSide } from "./Tooltip";

export type IconButtonSize = "inline" | "sm" | "md" | "lg";
export type IconButtonTone = "success" | "warning" | "danger";

const SIZE_CLASSES: Record<IconButtonSize, string> = {
	inline: "size-(--sc-icon-md) rounded-(--sc-radius-sm) [&>svg]:size-(--sc-icon-sm)",
	sm: "size-(--sc-control-sm) rounded-(--sc-radius-sm) [&>svg]:size-(--sc-icon-sm)",
	md: "size-(--sc-control-md) rounded-(--sc-radius-md) [&>svg]:size-(--sc-icon-md)",
	lg: "size-(--sc-control-lg) rounded-(--sc-radius-md) [&>svg]:size-(--sc-icon-lg)",
};

const TONE_CLASSES: Record<IconButtonTone, string> = {
	success: "text-(--sc-success)",
	warning: "text-(--sc-warning)",
	danger: "text-(--sc-danger)",
};

/** A ghost's paint with its own icon colour (`tone`) or without the hover wash an icon-sized box has no room for. */
function quietPaint(tone: IconButtonTone | undefined, inline: boolean, inert: boolean): string {
	return cx(
		"border-transparent bg-transparent",
		tone ? TONE_CLASSES[tone] : "text-(--sc-text-secondary)",
		inert
			? "cursor-not-allowed opacity-50"
			: cx(!inline && "hover:bg-(--sc-hover) active:bg-(--sc-pressed)", !tone && "hover:text-(--sc-text)"),
	);
}

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children" | "aria-label"> {
	/** Accessible name and tooltip text. */
	label: string;
	icon: ReactNode;
	variant?: ButtonVariant;
	size?: IconButtonSize;
	/** A status colour for the icon; it replaces the variant's paint with a ghost's. */
	tone?: IconButtonTone;
	/** macOS-spelled shortcut shown in the tooltip. */
	shortcut?: string;
	/** Set false only when a visible label right next to the button already says the same. */
	tooltip?: boolean;
	tooltipSide?: TooltipSide;
	/** Toggle state; renders aria-pressed and the selected wash. */
	pressed?: boolean;
	/** The action is running: spinner instead of the icon, aria-busy, disabled. */
	loading?: boolean;
}

export function IconButton({
	label,
	icon,
	variant = "ghost",
	size = "md",
	tone,
	shortcut,
	tooltip = true,
	tooltipSide,
	pressed,
	loading,
	disabled,
	className,
	type,
	...rest
}: IconButtonProps) {
	const inert = Boolean(disabled || loading);
	const button = (
		<button
			aria-busy={loading || undefined}
			aria-label={label}
			aria-pressed={pressed}
			className={cx(
				"omp-pressable inline-flex shrink-0 select-none items-center justify-center border [&>svg]:shrink-0",
				tone || size === "inline" ? quietPaint(tone, size === "inline", inert) : buttonPaint(variant, inert),
				"aria-pressed:bg-(--sc-selected) aria-pressed:text-(--sc-text)",
				SIZE_CLASSES[size],
				className,
			)}
			disabled={inert}
			type={type ?? "button"}
			{...rest}
		>
			{loading ? <Spinner inheritColor size="sm" /> : icon}
		</button>
	);
	if (!tooltip) return button;
	return (
		<Tooltip content={label} describe={false} shortcut={shortcut} side={tooltipSide}>
			{button}
		</Tooltip>
	);
}
