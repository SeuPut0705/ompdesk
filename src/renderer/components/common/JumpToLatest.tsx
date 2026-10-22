/**
 * JumpToLatest — the floating pill that returns a scrolled-away transcript to its live edge.
 *
 * Sits at the bottom centre of a `relative` parent (`className` sets its `bottom-*` offset). While `pinned` (the
 * reader is already at the edge) it slides away, ignores the pointer and leaves the tab order and the
 * accessibility tree, so it is only ever there when it has something to do.
 */

import { ArrowDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

export interface JumpToLatestProps extends Omit<ComponentProps<"button">, "children" | "aria-label"> {
	/** The reader is at the live edge: hide the pill. */
	pinned: boolean;
}

export function JumpToLatest({ pinned, className, type, ...rest }: JumpToLatestProps) {
	const t = useT();
	const label = t("chat.jumpToLatest");
	return (
		<button
			aria-hidden={pinned || undefined}
			aria-label={label}
			className={cx(
				"absolute left-1/2 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-4 text-omp-md font-medium text-[var(--omp-text)] shadow-[var(--omp-shadow-md)] transition-all hover:bg-[var(--omp-selected-bg)]",
				pinned ? "pointer-events-none translate-y-12 opacity-0" : "translate-y-0 opacity-100",
				className,
			)}
			tabIndex={pinned ? -1 : 0}
			type={type ?? "button"}
			{...rest}
		>
			<ArrowDown aria-hidden size={14} />
			{label}
		</button>
	);
}
