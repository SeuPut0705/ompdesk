/**
 * OptionRow — one row of a picker's listbox (command palette, session, branch and file pickers, the tab switcher):
 * `role="option"` under a `role="listbox"` whose field drives the highlight with `aria-activedescendant`
 * (lib/listbox-nav.ts), so the row itself is never a tab stop of its own (`tabIndex` -1 unless a caller says
 * otherwise): Tab from the field leaves the list instead of walking every result.
 *
 * `active` is the keyboard/hover highlight (the row Enter picks); `selected` is `aria-selected` (the current item, or
 * the highlighted one where the picker says so). `size`: `md` rows with a second line (36 px under a mouse, 40 under a
 * finger), `sm` 36 px single-line rows, `xs` 28 px dense rows with tighter insets (the model picker's long lists).
 * A disabled row is dimmed and shows the not-allowed cursor.
 * Give it a stable `id` for `aria-activedescendant`. A navigable list without a field is a `ListRow`.
 * `pointerMoves`: the list moves `active` to the row under the pointer itself, so the row draws no hover tint of its
 * own (one highlight, never a hover beside the keyboard's).
 */

import type { ComponentProps } from "react";
import { cx } from "../../lib/format";

export interface OptionRowProps extends Omit<ComponentProps<"button">, "role"> {
	active: boolean;
	selected?: boolean;
	size?: "xs" | "sm" | "md";
	pointerMoves?: boolean;
}

const SIZE: Record<NonNullable<OptionRowProps["size"]>, string> = {
	xs: "min-h-(--sc-control-sm) gap-2 px-2 py-0.5",
	sm: "min-h-9 gap-2.5 px-2.5 py-1.5",
	md: "min-h-9 gap-2.5 px-2.5 py-1.5 [html[data-input=touch]_&]:min-h-10 [html[data-input=touch]_&]:py-2",
};

export function OptionRow({ active, selected, size = "md", pointerMoves, className, type, ...rest }: OptionRowProps) {
	return (
		<button
			tabIndex={-1}
			{...rest}
			aria-selected={selected ?? active}
			className={cx(
				"flex w-full items-center rounded-(--sc-radius-md) text-left disabled:cursor-not-allowed disabled:opacity-50",
				SIZE[size],
				active ? "bg-(--sc-selected)" : !pointerMoves && "hover:bg-(--sc-hover)",
				className,
			)}
			role="option"
			type={type ?? "button"}
		/>
	);
}
