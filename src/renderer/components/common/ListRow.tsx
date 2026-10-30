/**
 * ListRow — one item in a navigable list: sessions in the sidebar, agents,
 * providers, plugins, search results.
 *
 * Anatomy: leading (icon/avatar/status dot) · title + optional description
 * · meta (right-aligned quiet text: time, count, Kbd) · trailing (an
 * always-visible control such as a disclosure) · actions (IconButtons
 * revealed on hover and keyboard focus — never display:none, so they stay
 * in the tab order). The whole row is one click target (`onClick`); actions
 * and trailing sit above it and stop nothing. `selected` marks the current item
 * (aria-current). Min height 32px (compact) / 40px (with description).
 * Rows are colorless at rest; hover and selection are neutral washes.
 * `rowProps` / `buttonProps` pass extra attributes to the row and its
 * button — e.g. onContextMenu and a roving `tabIndex` for long lists (one
 * tab stop + arrow keys).
 */

import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../../lib/format";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface ListRowProps {
	title: ReactNode;
	description?: ReactNode;
	leading?: ReactNode;
	/** Quiet right-aligned text (relative time, count) or a Kbd. */
	meta?: ReactNode;
	/** Row actions (IconButton size sm); shown on hover / keyboard focus / selected. */
	actions?: ReactNode;
	/** How many actions show at most, so the title keeps clear of them (room for two when omitted). */
	actionCount?: number;
	/**
	 * Actions show only on hover or keyboard focus (`:focus-visible` inside the row, so the row a click focused keeps its
	 * meta), selected or not, and overlay the row's end on a fade. They take the meta's place while they show: the meta
	 * steps aside and the title runs on under the fade up to them, so a row with one action (the sidebar's ⋯) reads more
	 * of its title on hover, not less. Nothing else moves.
	 */
	actionsOnHover?: boolean;
	/**
	 * Touch: there is no hover to reveal anything, so the actions are an ordinary control after the meta, shown
	 * for every row and never over the title (the row loses the width, not its actions). Wins over `actionsOnHover`.
	 */
	actionsAtRest?: boolean;
	/** Always-visible control at the right edge (e.g. a disclosure); actions show to its left. */
	trailing?: ReactNode;
	selected?: boolean;
	disabled?: boolean;
	onClick?: () => void;
	/** Native tooltip for truncated titles. */
	titleText?: string;
	className?: string;
	/** Extra attributes for the row element (context menu, data-* hooks). */
	rowProps?: Omit<HTMLAttributes<HTMLDivElement>, "className" | "children"> & DataAttributes;
	/** Extra attributes for the row's button (roving `tabIndex`, keyboard handlers, data-* hooks). */
	buttonProps?: Omit<
		ButtonHTMLAttributes<HTMLButtonElement>,
		"className" | "children" | "onClick" | "type" | "disabled" | "title"
	> &
		DataAttributes;
}

/**
 * Right padding that keeps the title clear of the overlaid actions: n buttons of 28px, the 2px gaps and
 * the 6px edge offset. Static strings, so Tailwind finds them. `group-has-[:focus-visible]` is keyboard focus
 * anywhere in the row: a mouse click leaves the row focused (`:focus-within`), and that kept the actions over the
 * selected row's title for as long as it stayed selected.
 */
const ACTION_ROOM = [
	{ reveal: "group-has-[:focus-visible]/row:pr-9 group-hover/row:pr-9", always: "pr-9", var: "[--row-room:2.25rem]" },
	{
		reveal: "group-has-[:focus-visible]/row:pr-14 group-hover/row:pr-14",
		always: "pr-14",
		var: "[--row-room:3.5rem]",
	},
	{ reveal: "group-has-[:focus-visible]/row:pr-24 group-hover/row:pr-24", always: "pr-24", var: "[--row-room:6rem]" },
	{ reveal: "group-has-[:focus-visible]/row:pr-32 group-hover/row:pr-32", always: "pr-32", var: "[--row-room:8rem]" },
] as const;

/**
 * Quiet actions: the title end fades out just before the overlay (`--row-room` from the row's end) instead of
 * making room, so nothing shifts.
 */
const QUIET_FADE =
	"group-hover/row:mask-[linear-gradient(to_right,#000_calc(100%-var(--row-room)),transparent_calc(100%-var(--row-room)+0.75rem))] group-has-[:focus-visible]/row:mask-[linear-gradient(to_right,#000_calc(100%-var(--row-room)),transparent_calc(100%-var(--row-room)+0.75rem))]";

export function ListRow({
	title,
	description,
	leading,
	meta,
	actions,
	actionCount,
	actionsOnHover,
	actionsAtRest,
	trailing,
	selected,
	disabled,
	onClick,
	titleText,
	className,
	rowProps,
	buttonProps,
}: ListRowProps) {
	// The row's button carries only the title as its name; the description (a path, an account) is its description,
	// so two rows of one title stay apart for a screen reader.
	const descriptionId = useId();
	const describedBy = [buttonProps?.["aria-describedby"], description ? descriptionId : undefined]
		.filter(Boolean)
		.join(" ");
	const room = ACTION_ROOM[Math.min(Math.max(actionCount ?? 2, 1), ACTION_ROOM.length) - 1] ?? ACTION_ROOM[1];
	// Overlaid on the right edge (left of `trailing`) so hidden actions never
	// reserve the width the title needs at rest.
	const actionsOverlay = actions && !actionsAtRest && (
		<span
			className={cx(
				"absolute inset-y-0 z-(--sc-z-raised) flex items-center gap-0.5 opacity-0 transition-opacity duration-(--sc-duration-fast) group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100",
				actionsOnHover &&
					"pointer-events-none group-has-[:focus-visible]/row:pointer-events-auto group-hover/row:pointer-events-auto [@media(hover:none)]:pointer-events-auto",
				trailing ? "right-full pr-0.5" : "right-1.5",
				selected && !actionsOnHover && "opacity-100",
			)}
		>
			{actions}
		</span>
	);
	return (
		<div
			{...rowProps}
			className={cx(
				"omp-list-row group/row relative flex w-full items-center gap-2.5 rounded-(--sc-radius-md) px-2.5 text-left",
				description ? "min-h-10 py-1.5" : "min-h-8 py-1",
				selected ? "bg-(--sc-selected)" : onClick && !disabled && "hover:bg-(--sc-hover)",
				disabled && "opacity-50",
				className,
			)}
		>
			{leading && (
				<span className="flex shrink-0 items-center text-(--sc-text-muted) [&>svg]:size-(--sc-icon-md)">
					{leading}
				</span>
			)}
			<span
				className={cx(
					"flex-1",
					// The title is what tells rows apart: whatever sits beside it (a status badge, an age, a count, the
					// touch ⋯) gives way before the title drops under ten characters ("Fix the f…" beside a waiting badge
					// and a child count).
					meta != null || trailing != null || (actionsAtRest && actions != null)
						? "min-w-[min(10ch,50%)]"
						: "min-w-0",
					// Actions overlay the right edge; make room only while they show.
					actions != null && !actionsOnHover && !actionsAtRest && room.reveal,
					actions != null && !actionsOnHover && !actionsAtRest && selected && room.always,
					actions != null && actionsOnHover && !actionsAtRest && cx(room.var, QUIET_FADE),
					// No hover at all (a finger): the actions show at rest and the title yields their room.
					actions != null && !actionsAtRest && cx(room.var, "[@media(hover:none)]:pr-(--row-room)"),
				)}
			>
				{onClick ? (
					<button
						{...buttonProps}
						aria-current={selected ? "true" : undefined}
						aria-describedby={describedBy || undefined}
						className="block w-full truncate text-left text-sc-md text-(--sc-text) after:absolute after:inset-0 after:rounded-(--sc-radius-md) focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-(--sc-focus-ring) disabled:cursor-not-allowed"
						disabled={disabled}
						onClick={onClick}
						title={titleText}
						type="button"
					>
						{title}
					</button>
				) : (
					<span className="block truncate text-sc-md text-(--sc-text)" title={titleText}>
						{title}
					</span>
				)}
				{description && (
					<span className="block truncate text-sc-sm text-(--sc-text-muted)" id={descriptionId}>
						{description}
					</span>
				)}
			</span>
			{meta && (
				<span
					className={cx(
						// Shrinks down to its content's least width (a badge's word truncates inside it, its glyph and an
						// age stay whole) once the title is down to its floor.
						"flex shrink items-center justify-end text-sc-xs whitespace-nowrap tabular-nums text-(--sc-text-muted)",
						actions && !actionsAtRest
							? cx(
									actionsOnHover
										? "group-has-[:focus-visible]/row:hidden group-hover/row:hidden [@media(hover:none)]:invisible"
										: "group-has-[:focus-visible]/row:hidden group-hover/row:hidden [@media(hover:none)]:hidden",
									selected && !actionsOnHover && "hidden",
								)
							: undefined,
					)}
				>
					{meta}
				</span>
			)}
			{actionsAtRest && actions != null && (
				<span className="relative z-(--sc-z-raised) -mr-1.5 flex shrink-0 items-center gap-0.5">{actions}</span>
			)}
			{trailing ? (
				<span className="relative z-(--sc-z-raised) flex shrink-0 items-center">
					{actionsOverlay}
					{trailing}
				</span>
			) : (
				actionsOverlay
			)}
		</div>
	);
}
