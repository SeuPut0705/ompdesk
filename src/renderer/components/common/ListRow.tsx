/**
 * ListRow — one item in a navigable list: sessions in the sidebar, agents,
 * providers, plugins, search results, a side panel's files and branches.
 *
 * Anatomy: leading (icon/avatar/status dot) · title + optional description
 * and `secondary` line · meta (right-aligned quiet text: time, count, Kbd) ·
 * trailing (an always-visible control such as a disclosure) · actions
 * (IconButtons revealed on hover and keyboard focus — never display:none, so
 * they stay in the tab order). The whole row is one click target (`onClick`);
 * actions and trailing sit above it and stop nothing. `selected` marks the
 * current item (aria-current); a current row that is also `disabled` (the
 * branch you are on: pressing it would do nothing) is not dimmed.
 * `size`: `md` (default) min height 32px, 40px with a second line; `sm` the
 * dense row of a side panel's list, 28px (36px with a second line), small text.
 * `titleLines={2}` lets a long title (a pull request's) wrap once before it is
 * cut. `secondary` is a free muted line under the title whose parts each shrink
 * or stay whole on their own (a number, an author, a branch, counts, an age).
 * The button is named by the title and described by the description and the
 * secondary line; `accessibleName="row"` names it by every text of the row in
 * order, for a list whose rows are found by any of their words.
 * Rows are colorless at rest; hover and selection are neutral washes.
 * `rowProps` / `buttonProps` pass extra attributes to the row and its
 * button — e.g. onContextMenu and a roving `tabIndex` for long lists (one
 * tab stop + arrow keys), a `style` for an outline's indent.
 */

import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, useId } from "react";
import { cx } from "../../lib/format";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface ListRowProps {
	title: ReactNode;
	/** Lines the title may take before it is cut: 1 (default) or 2 (a pull request's title). */
	titleLines?: 1 | 2;
	description?: ReactNode;
	/** Lines the description may take before it is cut: 1 (default) or 2 (a search hit's snippet). */
	descriptionLines?: 1 | 2;
	/** A muted one-line row of parts under the title and description; each part sets how it shrinks. */
	secondary?: ReactNode;
	/** `md` (default) or `sm`, the dense side-panel row. */
	size?: "sm" | "md";
	/** What names the row's button: the `title` (default) or every text of the `row` in order. */
	accessibleName?: "title" | "row";
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
	titleLines = 1,
	description,
	descriptionLines = 1,
	secondary,
	size = "md",
	accessibleName = "title",
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
	const baseId = useId();
	const titleId = `${baseId}title`;
	const descriptionId = `${baseId}description`;
	const secondaryId = `${baseId}secondary`;
	const metaId = `${baseId}meta`;
	const wholeRow = accessibleName === "row";
	// By default the button carries only the title as its name; the description (a path, an account) and the
	// secondary line describe it, so two rows of one title stay apart for a screen reader.
	const describedBy = [
		buttonProps?.["aria-describedby"],
		!wholeRow && description ? descriptionId : undefined,
		!wholeRow && secondary ? secondaryId : undefined,
	]
		.filter(Boolean)
		.join(" ");
	const labelledBy = wholeRow
		? [
				titleId,
				description ? descriptionId : undefined,
				secondary ? secondaryId : undefined,
				meta ? metaId : undefined,
			]
				.filter(Boolean)
				.join(" ")
		: undefined;
	const small = size === "sm";
	const twoLines = Boolean(description || secondary);
	const titleClass = cx(
		"text-(--sc-text)",
		small ? "text-sc-sm" : "text-sc-md",
		titleLines === 2 ? "line-clamp-2 break-words" : "truncate",
	);
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
				"omp-list-row group/row relative flex w-full items-center text-left",
				small ? "gap-2 rounded-(--sc-radius-sm) px-2" : "gap-2.5 rounded-(--sc-radius-md) px-2.5",
				small
					? twoLines
						? "min-h-9 py-1"
						: "min-h-(--sc-control-sm) py-1"
					: twoLines
						? "min-h-10 py-1.5"
						: "min-h-8 py-1",
				selected ? "bg-(--sc-selected)" : onClick && !disabled && "hover:bg-(--sc-hover)",
				disabled && !selected && "opacity-50",
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
					// The title is what tells rows apart: sized by its own text, it gives way only once the row's end (a
					// waiting badge's word) has given what it can (meta below shrinks 99× faster). With a zero basis it got
					// only what the badge, the age and a child count left: "Fix the f…".
					"min-w-0 flex-[1_1_auto]",
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
						aria-labelledby={labelledBy}
						className={cx(
							"block w-full text-left after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-(--sc-focus-ring) disabled:cursor-not-allowed",
							small ? "after:rounded-(--sc-radius-sm)" : "after:rounded-(--sc-radius-md)",
							titleClass,
						)}
						disabled={disabled}
						onClick={onClick}
						title={titleText}
						type="button"
					>
						<span id={titleId}>{title}</span>
					</button>
				) : (
					<span className={cx("block", titleClass)} id={titleId} title={titleText}>
						{title}
					</span>
				)}
				{description && (
					<span
						className={cx(
							"text-(--sc-text-muted)",
							small ? "text-sc-xs" : "text-sc-sm",
							descriptionLines === 2 ? "line-clamp-2 break-words" : "block truncate",
						)}
						id={descriptionId}
					>
						{description}
					</span>
				)}
				{secondary && (
					<span
						className="flex min-w-0 items-center gap-2 overflow-hidden text-sc-xs whitespace-nowrap text-(--sc-text-muted)"
						id={secondaryId}
					>
						{secondary}
					</span>
				)}
			</span>
			{meta && (
				<span
					id={metaId}
					className={cx(
						// Down to `--row-meta-min` (its whole content unless the list sets less: the sidebar lets a waiting
						// badge's word go, down to its ⚠ glyph) before the title loses a character.
						"flex min-w-(--row-meta-min,min-content) flex-[0_99_auto] items-center justify-end overflow-hidden text-sc-xs whitespace-nowrap tabular-nums text-(--sc-text-muted)",
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
