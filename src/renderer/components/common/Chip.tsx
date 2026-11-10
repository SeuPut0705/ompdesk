/**
 * Chip — a small pill (24 px, xs text) for one value among others in a row: a filter or focus area the person turns on
 * and off, a queued message, a pasted text, a picked model.
 *
 * - A toggle: `pressed` and `onPressedChange`. Off it is an outline; on it wears the accent's soft wash with the accent
 *   text (`aria-pressed`), and a ✓ leads it when it has no `icon` of its own, so colour is never the only cue.
 * - A removable chip: `onRemove` with `removeLabel` (the ✕'s accessible name and tooltip, naming the chip: "Remove
 *   notes.md"). Its label may itself be a button (`onClick`: put the queued text back in the field), named by
 *   `actionLabel` when the visible text alone does not say what a press does. `trailing` holds what sits between the
 *   label and the ✕ (picture tiles, a retry glyph: `IconButton size="inline"`).
 * - Otherwise a plain chip: a button with `onClick`, or a static label.
 * `icon` leads the label (decorative, or a mark with its own kit `Tooltip`); `tooltip` is the whole of a label the
 * chip cuts (`max-w-*` in `className`), shown by the kit Tooltip on hover, focus and a tap. `as="li"` makes the chip a
 * list item of a `<ul>`. `data-*` attributes reach the chip's root.
 *
 * Touch: the chip is never drawn bigger. Its buttons take the reach of styles/mobile.css's hit-area rule; a row of
 * chips sets that rule's `--hit-gap-x`/`--hit-gap-y` (and the same `gap`) on its container, e.g.
 * `html[data-input="touch"] [data-focus-chips] { gap: 10px; --hit-gap-x: 10px; --hit-gap-y: 10px; }`. Inside a
 * removable chip the label and the ✕ split the space between them (the chip bounds their reach sideways to its
 * 4 px gap), so a tap on the label's end never removes the chip.
 */

import { Check, X } from "lucide-react";
import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { cx } from "../../lib/format";
import { IconButton } from "./IconButton";
import { Tooltip } from "./Tooltip";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

type ChipCommon = DataAttributes & {
	/** The label. */
	children: ReactNode;
	/** A mark before the label. */
	icon?: ReactNode;
	/** The whole of a label the chip cuts. */
	tooltip?: string;
	/** Nothing in the chip can be pressed: the toggle, the label button and the ✕ fade and refuse. */
	disabled?: boolean;
	as?: "span" | "li";
	className?: string;
};

export type ChipProps = ChipCommon &
	(
		| {
				pressed: boolean;
				onPressedChange: (pressed: boolean) => void;
				onClick?: never;
				actionLabel?: never;
				onRemove?: never;
				removeLabel?: never;
				trailing?: never;
		  }
		| {
				pressed?: never;
				onPressedChange?: never;
				/** The label is a button that does this. */
				onClick?: () => void;
				/** The label button's accessible name, when its text alone does not say what a press does. */
				actionLabel?: string;
				/** Between the label and the ✕. */
				trailing?: ReactNode;
				onRemove: () => void;
				/** The ✕'s accessible name and tooltip. */
				removeLabel: string;
		  }
		| {
				pressed?: never;
				onPressedChange?: never;
				onClick?: () => void;
				actionLabel?: string;
				trailing?: ReactNode;
				onRemove?: never;
				removeLabel?: never;
		  }
	);

const PILL =
	"inline-flex h-6 max-w-full min-w-0 shrink-0 items-center gap-1 rounded-(--sc-radius-full) border px-2 text-sc-xs [&>svg]:size-(--sc-icon-sm) [&>svg]:shrink-0";
const QUIET = "border-(--sc-border-subtle) bg-(--sc-surface-2) text-(--sc-text-secondary)";

export function Chip({
	children,
	icon,
	tooltip,
	disabled,
	as: Root = "span",
	className,
	pressed,
	onPressedChange,
	onClick,
	actionLabel,
	trailing,
	onRemove,
	removeLabel,
	...data
}: ChipProps) {
	const withTooltip = (element: ReactElement<HTMLAttributes<HTMLElement>>) =>
		tooltip ? (
			<Tooltip content={tooltip} describe={actionLabel !== undefined}>
				{element}
			</Tooltip>
		) : (
			element
		);

	if (onPressedChange) {
		const toggle = (
			<button
				{...data}
				aria-pressed={pressed}
				className={cx(
					PILL,
					"transition-colors duration-(--sc-duration-fast) disabled:cursor-not-allowed disabled:opacity-50",
					pressed
						? "border-(--sc-accent-border) bg-(--sc-accent-soft) text-(--sc-accent-on-soft)"
						: "border-(--sc-border) bg-transparent text-(--sc-text-secondary) enabled:hover:bg-(--sc-hover) enabled:hover:text-(--sc-text)",
					className,
				)}
				disabled={disabled}
				onClick={() => onPressedChange(!pressed)}
				type="button"
			>
				{icon ?? (pressed ? <Check aria-hidden /> : null)}
				<span className="min-w-0 truncate">{children}</span>
			</button>
		);
		return Root === "li" ? <li className="inline-flex">{withTooltip(toggle)}</li> : withTooltip(toggle);
	}

	if (!onRemove && !trailing) {
		const plain = onClick ? (
			<button
				{...data}
				aria-label={actionLabel}
				className={cx(
					PILL,
					QUIET,
					"enabled:hover:text-(--sc-text) disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
				disabled={disabled}
				onClick={onClick}
				type="button"
			>
				{icon}
				<span className="min-w-0 truncate">{children}</span>
			</button>
		) : (
			<span {...data} className={cx(PILL, QUIET, className)}>
				{icon}
				<span className="min-w-0 truncate">{children}</span>
			</span>
		);
		return Root === "li" ? <li className="inline-flex">{withTooltip(plain)}</li> : withTooltip(plain);
	}

	const label = onClick ? (
		<button
			aria-label={actionLabel}
			className="min-w-0 truncate rounded-(--sc-radius-sm) text-left enabled:hover:text-(--sc-text) disabled:cursor-not-allowed disabled:opacity-50"
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	) : (
		<span className="min-w-0 truncate">{children}</span>
	);
	return (
		<Root {...data} className={cx(PILL, QUIET, onRemove && "pr-1 [--hit-gap-x:var(--sc-space-1)]", className)}>
			{icon}
			{withTooltip(label)}
			{trailing}
			{onRemove && (
				<IconButton disabled={disabled} icon={<X />} label={removeLabel ?? ""} onClick={onRemove} size="inline" />
			)}
		</Root>
	);
}
