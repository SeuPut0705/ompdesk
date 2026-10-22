/**
 * OptionRow — one row of a picker's listbox (command palette, session, branch and file pickers, the tab switcher):
 * `role="option"` under a `role="listbox"` whose field drives the highlight with `aria-activedescendant`
 * (lib/listbox-nav.ts), so the row itself is never a tab stop of its own.
 *
 * `active` is the keyboard/hover highlight (the row Enter picks); `selected` is `aria-selected` (the current item, or
 * the highlighted one where the picker says so). `size`: `md` 40 px rows with a second line, `sm` 36 px single-line
 * rows. Give it a stable `id` for `aria-activedescendant`. A navigable list without a field is a `ListRow`.
 */

import type { ComponentProps } from "react";
import { cx } from "../../lib/format";

export interface OptionRowProps extends Omit<ComponentProps<"button">, "role"> {
	active: boolean;
	selected?: boolean;
	size?: "sm" | "md";
}

export function OptionRow({ active, selected, size = "md", className, type, ...rest }: OptionRowProps) {
	return (
		<button
			{...rest}
			aria-selected={selected ?? active}
			className={cx(
				"flex w-full items-center gap-2.5 rounded-(--sc-radius-md) px-2.5 text-left disabled:opacity-50",
				size === "md" ? "min-h-10 py-2" : "min-h-9 py-1.5",
				active ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
				className,
			)}
			role="option"
			type={type ?? "button"}
		/>
	);
}
