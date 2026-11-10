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
 *
 * A button that cannot be pressed (`disabled`, or busy with `loading`) loses its hover and press and shows the
 * not-allowed cursor. A disabled primary keeps its identity as the main action, not ready yet: the accent's soft wash
 * with the accent text drawn on it (`--sc-accent-on-soft`, the badge pair `lib/theme-contrast.ts` holds at the text
 * floor in every theme), never a grey chip that reads like the Cancel beside it. The other variants fade to half.
 * `disabledReason` says why it cannot be pressed: the button then stays focusable (`aria-disabled`, the press does
 * nothing and submits nothing) and the kit Tooltip shows the reason on hover, on keyboard focus and on a tap.
 */

import type { ComponentProps, ReactNode } from "react";
import { cx } from "../../lib/format";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-soft";
export type ButtonSize = "sm" | "md" | "lg";

const PAINT: Record<ButtonVariant, { rest: string; live: string }> = {
	primary: {
		rest: "border-transparent bg-(--sc-accent) text-(--sc-accent-fg) shadow-(--sc-shadow-sm)",
		live: "hover:bg-(--sc-accent-hover) active:brightness-95",
	},
	secondary: {
		rest: "border-(--sc-border-subtle) bg-transparent text-(--sc-text)",
		live: "hover:border-(--sc-border) hover:bg-(--sc-hover) active:bg-(--sc-pressed)",
	},
	ghost: {
		rest: "border-transparent bg-transparent text-(--sc-text-secondary)",
		live: "hover:bg-(--sc-hover) hover:text-(--sc-text) active:bg-(--sc-pressed)",
	},
	danger: {
		rest: "border-transparent bg-(--sc-danger) text-(--sc-danger-fg) shadow-(--sc-shadow-sm)",
		live: "hover:brightness-110 active:brightness-95",
	},
	"danger-soft": {
		rest: "border-(--sc-danger) bg-(--sc-danger-soft) text-(--sc-danger-on-soft)",
		live: "hover:brightness-110 active:brightness-95",
	},
};

/** Variant paint, shared with IconButton so both stay one visual family; `inert` when it cannot be pressed. */
export function buttonPaint(variant: ButtonVariant, inert: boolean): string {
	if (!inert) return cx(PAINT[variant].rest, PAINT[variant].live);
	return cx(
		"cursor-not-allowed shadow-none",
		variant === "primary"
			? "border-transparent bg-(--sc-accent-soft) text-(--sc-accent-on-soft)"
			: cx(PAINT[variant].rest, "opacity-50"),
	);
}

type PressHandler =
	| "onClick"
	| "onMouseDown"
	| "onMouseUp"
	| "onPointerDown"
	| "onPointerUp"
	| "onTouchStart"
	| "onTouchEnd"
	| "onKeyDown"
	| "onKeyUp";

/**
 * A disabled control that explains itself (`aria-disabled`, focusable) drops its caller's press and key handlers, so
 * no pointer-down or Enter acts; focus, blur and hover stay for its Tooltip. Shared with IconButton.
 */
export function withoutPress<T extends Partial<Record<PressHandler, unknown>>>(props: T): Omit<T, PressHandler> {
	const {
		onClick: _click,
		onMouseDown: _mouseDown,
		onMouseUp: _mouseUp,
		onPointerDown: _pointerDown,
		onPointerUp: _pointerUp,
		onTouchStart: _touchStart,
		onTouchEnd: _touchEnd,
		onKeyDown: _keyDown,
		onKeyUp: _keyUp,
		...kept
	} = props;
	return kept;
}

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
	/** With `disabled`: why it cannot be pressed now, in the kit Tooltip on hover, focus and a tap. */
	disabledReason?: string;
}

export function Button({
	variant = "secondary",
	size = "md",
	icon,
	trailingIcon,
	loading,
	disabled,
	disabledReason,
	className,
	children,
	type,
	onClick,
	...rest
}: ButtonProps) {
	const inert = Boolean(disabled || loading);
	const explained = Boolean(disabled && !loading && disabledReason);
	const button = (
		<button
			type={type ?? "button"}
			className={cx(
				"omp-pressable inline-flex shrink-0 select-none items-center justify-center border font-medium whitespace-nowrap [&>svg]:shrink-0",
				buttonPaint(variant, inert),
				SIZE_CLASSES[size],
				className,
			)}
			{...(explained ? withoutPress(rest) : rest)}
			aria-disabled={explained || undefined}
			disabled={inert && !explained}
			onClick={explained ? undefined : onClick}
			// A press on a disabled button that explains itself does nothing, and a submit button submits nothing.
			onClickCapture={explained ? event => event.preventDefault() : rest.onClickCapture}
		>
			{loading ? <Spinner inheritColor size="sm" spin /> : icon}
			{children}
			{trailingIcon}
		</button>
	);
	if (!explained) return button;
	return <Tooltip content={disabledReason}>{button}</Tooltip>;
}
