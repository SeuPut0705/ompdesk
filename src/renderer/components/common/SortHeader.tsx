/**
 * SortHeader — a table's column header that sorts the rows by its column: the `<th scope="col">` with `aria-sort`, and
 * inside it one button named by the column's label, followed by the direction glyph (↑ ascending, ↓ descending, a quiet
 * ↕ on a column the table is not sorted by). `direction` is this column's order, `null` when another column sorts the
 * table; `onSort` asks the table to sort by it (or to turn the order around when it already does). Only the sorted
 * column carries `aria-sort`, as the ARIA practices ask. `className` takes the cell's padding and border; `align="end"`
 * for a numeric column.
 */

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cx } from "../../lib/format";

export type SortDirection = "ascending" | "descending";

export interface SortHeaderProps {
	label: string;
	direction: SortDirection | null;
	onSort: () => void;
	align?: "start" | "end";
	className?: string;
}

export function SortHeader({ label, direction, onSort, align = "start", className }: SortHeaderProps) {
	const Icon = direction === "ascending" ? ArrowUp : direction === "descending" ? ArrowDown : ArrowUpDown;
	return (
		<th
			aria-sort={direction ?? undefined}
			className={cx("font-medium whitespace-nowrap", align === "end" ? "text-right" : "text-left", className)}
			scope="col"
		>
			<button
				className={cx(
					"inline-flex items-center gap-1 rounded-(--sc-radius-xs) text-sc-xs transition-colors duration-(--sc-duration-instant)",
					direction ? "text-(--sc-text)" : "text-(--sc-text-muted) hover:text-(--sc-text)",
				)}
				onClick={onSort}
				type="button"
			>
				{label}
				<Icon aria-hidden className={cx("size-3 shrink-0", !direction && "opacity-50")} />
			</button>
		</th>
	);
}
