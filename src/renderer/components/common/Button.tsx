/**
 * Button — every text-labelled action.
 *
 * - `primary`: the ONE main action of a view or dialog (accent fill). Never
 *   two primaries side by side; repeated row actions are never primary.
 * - `secondary`: alternative actions next to a primary, toolbar actions.
 * - `ghost`: low-emphasis actions inside dense UI (rows, headers, cancel).
 * - `danger`: the confirming action of a destructive flow only (ConfirmDialog).
 * - `danger-soft`: a destructive action that asks its own confirmation next (Autopilot's Stop now): it says danger
 *   without the confirming fill.
 * Sizes map to the control scale: sm 28px, md 32px (default), lg 36px.
 * Icon-only actions use IconButton, never a Button without text.
 */

import type { ComponentProps, ReactNode } from "react";
import { cx } from "../../lib/format";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-soft";
export type ButtonSize = "sm" | "md" | "lg";

/** Variant paint, shared with IconButton so both stay one visual family. */
export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
	primary:
		"border-transparent bg-(--sc-accent) text-(--sc-accent-fg) shadow-(--sc-shadow-sm) hover:bg-(--sc-accent-hover) active:brightness-95",
	secondary:
		"border-(--sc-border-subtle) bg-transparent text-(--sc-text) hover:border-(--sc-border) hover:bg-(--sc-hover) active:bg-(--sc-pressed)",
	ghost: "border-transparent bg-transparent text-(--sc-text-secondary) hover:bg-(--sc-hover) hover:text-(--sc-text) active:bg-(--sc-pressed)",
	danger:
		"border-transparent bg-(--sc-danger) text-(--sc-danger-fg) shadow-(--sc-shadow-sm) hover:brightness-110 active:brightness-95",
	"danger-soft":
		"border-(--sc-danger) bg-(--sc-danger-soft) text-(--sc-danger-on-soft) hover:brightness-110 active:brightness-95",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
	sm: "h-(--sc-control-sm) gap-1.5 rounded-(--sc-radius-sm) px-2.5 text-sc-sm [&>svg]:size-(--sc-icon-sm)",
	md: "h-(--sc-control-md) gap-1.5 rounded-(--sc-radius-md) px-3 text-sc-md [&>svg]:size-(--sc-icon-sm)",
	lg: "h-(--sc-control-lg) gap-2 rounded-(--sc-radius-md) px-4 text-sc-md [&>svg]:size-(--sc-icon-md)",
};

/** Native button props, `ref` included (React 19) so Popover/Tooltip anchors can point at a Button. */
export interface ButtonProps extends ComponentProps<"button"> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	/** Icon rendered before the label (lucide element); sized by the button. */
	icon?: ReactNode;
	/** Icon rendered after the label. */
	trailingIcon?: ReactNode;
	/** Show a spinner and disable interaction. */
	loading?: boolean;
}

export function Button({
	variant = "secondary",
	size = "md",
	icon,
	trailingIcon,
	loading,
	disabled,
	className,
	children,
	type,
	...rest
}: ButtonProps) {
	return (
		<button
			type={type ?? "button"}
			className={cx(
				"inline-flex shrink-0 select-none items-center justify-center border font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,filter] duration-(--sc-duration-fast) [&>svg]:shrink-0",
				"disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
				BUTTON_VARIANT_CLASSES[variant],
				SIZE_CLASSES[size],
				className,
			)}
			disabled={disabled || loading}
			{...rest}
		>
			{loading ? <Spinner inheritColor size="sm" spin /> : icon}
			{children}
			{trailingIcon}
		</button>
	);
}
