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
 * tab stop + arrow keys, design-spec §9.4).
 */

import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/format";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface ListRowProps {
	title: ReactNode;
	description?: ReactNode;
	leading?: ReactNode;
	/** Quiet right-aligned text (relative time, count) or a Kbd. */
	meta?: ReactNode;
	/** Row actions (IconButton size sm); shown on hover / focus-within / selected. */
	actions?: ReactNode;
	/** How many actions show at most, so the title keeps clear of them (room for two when omitted). */
	actionCount?: number;
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
 * the 6px edge offset. Static strings, so Tailwind finds them.
 */
const ACTION_ROOM = [
	{ reveal: "group-focus-within/row:pr-9 group-hover/row:pr-9", always: "pr-9" },
	{ reveal: "group-focus-within/row:pr-14 group-hover/row:pr-14", always: "pr-14" },
	{ reveal: "group-focus-within/row:pr-24 group-hover/row:pr-24", always: "pr-24" },
	{ reveal: "group-focus-within/row:pr-32 group-hover/row:pr-32", always: "pr-32" },
] as const;

export function ListRow({
	title,
	description,
	leading,
	meta,
	actions,
	actionCount,
	trailing,
	selected,
	disabled,
	onClick,
	titleText,
	className,
	rowProps,
	buttonProps,
}: ListRowProps) {
	const room = ACTION_ROOM[Math.min(Math.max(actionCount ?? 2, 1), ACTION_ROOM.length) - 1] ?? ACTION_ROOM[1];
	// Overlaid on the right edge (left of `trailing`) so hidden actions never
	// reserve the width the title needs at rest.
	const actionsOverlay = actions && (
		<span
			className={cx(
				"absolute inset-y-0 z-(--sc-z-raised) flex items-center gap-0.5 opacity-0 transition-opacity duration-(--sc-duration-fast) group-focus-within/row:opacity-100 group-hover/row:opacity-100",
				trailing ? "right-full pr-0.5" : "right-1.5",
				selected && "opacity-100",
			)}
		>
			{actions}
		</span>
	);
	return (
		<div
			{...rowProps}
			className={cx(
				"group/row relative flex w-full items-center gap-2.5 rounded-(--sc-radius-md) px-2.5 text-left",
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
					"min-w-0 flex-1",
					// Actions overlay the right edge; make room only while they show.
					actions != null && room.reveal,
					actions != null && selected && room.always,
				)}
			>
				{onClick ? (
					<button
						{...buttonProps}
						aria-current={selected ? "true" : undefined}
						className="block w-full truncate text-left text-sc-md text-(--sc-text) outline-none after:absolute after:inset-0 after:rounded-(--sc-radius-md) focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-(--sc-focus-ring) disabled:cursor-not-allowed"
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
				{description && <span className="block truncate text-sc-sm text-(--sc-text-muted)">{description}</span>}
			</span>
			{meta && (
				<span
					className={cx(
						"shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)",
						actions
							? cx("group-focus-within/row:hidden group-hover/row:hidden", selected && "hidden")
							: undefined,
					)}
				>
					{meta}
				</span>
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
