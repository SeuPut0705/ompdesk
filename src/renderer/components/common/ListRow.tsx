/**
 * ListRow — one item in a navigable list: sessions in the sidebar, agents,
 * providers, plugins, search results.
 *
 * Anatomy: leading (icon/avatar/status dot) · title + optional description
 * · meta (right-aligned quiet text: time, count, Kbd) · actions (IconButtons
 * revealed on hover and keyboard focus — never display:none, so they stay
 * in the tab order). The whole row is one click target (`onClick`); actions
 * sit above it and stop nothing. `selected` marks the current item
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

export function ListRow({
	title,
	description,
	leading,
	meta,
	actions,
	selected,
	disabled,
	onClick,
	titleText,
	className,
	rowProps,
	buttonProps,
}: ListRowProps) {
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
					actions != null && "group-focus-within/row:pr-14 group-hover/row:pr-14",
					actions != null && selected && "pr-14",
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
			{actions && (
				// Overlaid on the right edge so hidden actions never reserve the
				// width the title needs at rest.
				<span
					className={cx(
						"absolute inset-y-0 right-1.5 z-(--sc-z-raised) flex items-center gap-0.5 opacity-0 transition-opacity duration-(--sc-duration-fast) group-focus-within/row:opacity-100 group-hover/row:opacity-100",
						selected && "opacity-100",
					)}
				>
					{actions}
				</span>
			)}
		</div>
	);
}
