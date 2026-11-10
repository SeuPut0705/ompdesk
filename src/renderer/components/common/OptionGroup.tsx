/**
 * OptionGroup — one group of a picker's listbox (the command palette's categories, the theme picker's families, the
 * model picker's providers, the tools by source): `role="group"` named by its `label`, its `OptionRow`s inside. A
 * heading may not stand in a listbox, so the visible header is the name's look only (`aria-hidden`; the group's
 * `aria-label` says it): `SectionLabel`'s type, with an optional leading `icon` and a `count` after the name, lined up
 * with the rows' content. `action` follows the name in the header and stays reachable (a status `Badge`, a Connect
 * `Button`; `ml-auto` on one sends it to the end). `sticky` keeps the header at the list's top while its rows scroll
 * under it.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";
import { SECTION_LABEL_TEXT } from "./SectionLabel";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface OptionGroupProps extends DataAttributes {
	/** The group's name: its header and its accessible name. */
	label: string;
	/** A glyph before the name (a category's icon). */
	icon?: ReactNode;
	/** How many rows the group holds, after the name. */
	count?: number;
	/** Controls in the header after the name; they stay in the accessibility tree. */
	action?: ReactNode;
	/** The header stays at the list's top while the group's rows scroll under it. */
	sticky?: boolean;
	className?: string;
	children: ReactNode;
}

export function OptionGroup({ label, icon, count, action, sticky, className, children, ...data }: OptionGroupProps) {
	return (
		<div {...data} aria-label={label} className={className} role="group">
			<div
				className={cx(
					"flex min-h-6 items-center gap-1.5 px-2.5 pt-2 pb-1",
					sticky && "sticky top-0 z-(--sc-z-raised) bg-(--sc-elevated)",
				)}
				data-option-group-header=""
			>
				<span
					aria-hidden
					className={cx(
						"flex min-w-0 items-center gap-1.5 select-none [&>svg]:size-(--sc-icon-sm) [&>svg]:shrink-0",
						SECTION_LABEL_TEXT,
					)}
				>
					{icon}
					<span className="truncate">{label}</span>
					{count !== undefined && <span className="shrink-0 font-normal tabular-nums">{count}</span>}
				</span>
				{action}
			</div>
			{children}
		</div>
	);
}
