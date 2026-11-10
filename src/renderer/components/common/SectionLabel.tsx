/**
 * SectionLabel — the small muted label over a group of rows or fields (a settings group, a sheet's section, a list's
 * part). One look everywhere: extra-small, medium weight, wide tracking, uppercase where the script has case, in the
 * muted text colour. It is a heading (`as` `h3`, default, or `h4` under an `h3`), so a screen reader can jump between
 * groups; inside an ARIA listbox, where a heading is not allowed, a picker labels its groups another way.
 *
 * `count` follows the label as a plain figure ("PROJECTS 4"), never in a pill. `action` is a trailing slot for one
 * quiet control that acts on the whole group (a `LinkButton`, an `IconButton size="sm"`); the row then spans the
 * group's width with the action at its end. `className` places it (margins), never restyles it.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";

export interface SectionLabelProps {
	children: ReactNode;
	/** The heading level: `h3` under a page's or dialog's `h2`, `h4` under an `h3`. */
	as?: "h3" | "h4";
	/** How many items the group holds, shown after the label. */
	count?: number;
	/** One control acting on the whole group, at the row's end. */
	action?: ReactNode;
	id?: string;
	className?: string;
}

/** The label's type and colour, shared with a picker's group header (`OptionGroup`), which may not be a heading. */
export const SECTION_LABEL_TEXT = "text-sc-xs font-medium tracking-wide text-(--sc-text-muted) uppercase";

export function SectionLabel({ children, as: Heading = "h3", count, action, id, className }: SectionLabelProps) {
	const heading = (
		<Heading
			className={cx("flex min-w-0 items-baseline gap-1.5", SECTION_LABEL_TEXT, !action && className)}
			data-section-label=""
			id={id}
		>
			<span className="min-w-0 break-words">{children}</span>
			{count !== undefined && <span className="shrink-0 font-normal tabular-nums">{count}</span>}
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
