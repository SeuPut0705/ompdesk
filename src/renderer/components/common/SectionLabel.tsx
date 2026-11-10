/**
 * SectionLabel — the heading over a group of rows or fields, in one of two sizes, so every section heading in the app
 * is this component:
 * - `label` (default): the small muted label over a settings group, a sheet's section, a list's part. Extra-small,
 *   medium weight, wide tracking, uppercase where the script has case, in the muted text colour.
 * - `title`: the section title of a content page or a detail pane (Insights' and Stats' sections, a pull request's
 *   Checks and Files). Medium size, semibold, in the text colour.
 *
 * It is a heading (`as` `h3`, default, or `h4` under an `h3`), so a screen reader can jump between groups. `as="div"`
 * draws the same look where a heading is not allowed or would be noise (a label inside a control's own box); inside
 * an ARIA listbox a picker labels its groups with `OptionGroup`.
 *
 * `count` follows the label as a plain figure ("PROJECTS 4"), never in a pill. `action` is a trailing slot for one
 * quiet control that acts on the whole group (a `LinkButton`, an `IconButton size="sm"`); the row then spans the
 * group's width with the action at its end. `className` places it (margins, `first:mt-0`), never restyles it.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";

export interface SectionLabelProps {
	children: ReactNode;
	/** The element: `h3` under a page's or dialog's `h2`, `h4` under an `h3`, `div` where no heading belongs. */
	as?: "h3" | "h4" | "div";
	/** `label` the small muted label (default), `title` a content section's title. */
	size?: "label" | "title";
	/** How many items the group holds, shown after the label. */
	count?: number;
	/** One control acting on the whole group, at the row's end. */
	action?: ReactNode;
	id?: string;
	className?: string;
}

/** The label's type and colour, shared with a picker's group header (`OptionGroup`), which may not be a heading. */
export const SECTION_LABEL_TEXT = "text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase";

const SECTION_TITLE_TEXT = "text-sc-md font-semibold text-(--sc-text)";

export function SectionLabel({
	children,
	as: Heading = "h3",
	size = "label",
	count,
	action,
	id,
	className,
}: SectionLabelProps) {
	const heading = (
		<Heading
			className={cx(
				"flex min-w-0 items-baseline gap-1.5",
				size === "title" ? SECTION_TITLE_TEXT : SECTION_LABEL_TEXT,
				!action && className,
			)}
			data-section-label={size}
			id={id}
		>
			<span className="min-w-0 break-words">{children}</span>
			{count !== undefined && (
				<span className={cx("shrink-0 tabular-nums", size === "title" ? "text-(--sc-text-muted)" : "font-normal")}>
					{count}
				</span>
			)}
		</Heading>
	);
	if (!action) return heading;
	return (
		<div className={cx("flex min-h-(--sc-control-sm) items-center justify-between gap-2", className)}>
			{heading}
			<div className="flex shrink-0 items-center gap-1">{action}</div>
		</div>
	);
}
