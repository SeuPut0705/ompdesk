/**
 * IconButton — an action shown as an icon alone.
 *
 * `label` is required: it is the accessible name and the tooltip text (pass
 * `shortcut` to show the chord too). Square hit targets on the control
 * scale — sm 28px (dense rows, dialog close), md 32px (toolbars, default),
 * lg 36px — with icons at 14 / 16 / 20px; the icon's own size is overridden.
 * `pressed` makes it a toggle (aria-pressed). `loading` swaps the icon for a
 * Spinner in the icon's place (same box, so nothing shifts), marks the button
 * busy and disables it — the one way a refresh or row action shows it is
 * running. Defaults to the ghost variant;
 * use `primary` only for the single main action of a surface (send).
 */

import type { ComponentProps, ReactNode } from "react";
import { cx } from "../../lib/format";
import { BUTTON_VARIANT_CLASSES, type ButtonVariant } from "./Button";
import { Spinner } from "./Spinner";
import { Tooltip, type TooltipSide } from "./Tooltip";

export type IconButtonSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<IconButtonSize, string> = {
	sm: "size-(--sc-control-sm) rounded-(--sc-radius-sm) [&>svg]:size-(--sc-icon-sm)",
	md: "size-(--sc-control-md) rounded-(--sc-radius-md) [&>svg]:size-(--sc-icon-md)",
	lg: "size-(--sc-control-lg) rounded-(--sc-radius-md) [&>svg]:size-(--sc-icon-lg)",
};

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children" | "aria-label"> {
	/** Accessible name and tooltip text. */
	label: string;
	icon: ReactNode;
	variant?: ButtonVariant;
	size?: IconButtonSize;
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
	const button = (
		<button
			aria-busy={loading || undefined}
			aria-label={label}
			aria-pressed={pressed}
			className={cx(
				"inline-flex shrink-0 select-none items-center justify-center border transition-[background-color,border-color,color,filter] duration-(--sc-duration-fast) [&>svg]:shrink-0",
				"disabled:cursor-not-allowed disabled:opacity-50",
				BUTTON_VARIANT_CLASSES[variant],
				"aria-pressed:bg-(--sc-selected) aria-pressed:text-(--sc-text)",
				SIZE_CLASSES[size],
				className,
			)}
			disabled={disabled || loading}
			type={type ?? "button"}
			{...rest}
		>
			{loading ? <Spinner inheritColor size="sm" spin /> : icon}
		</button>
	);
	if (!tooltip) return button;
	return (
		<Tooltip content={label} describe={false} shortcut={shortcut} side={tooltipSide}>
			{button}
		</Tooltip>
	);
}
