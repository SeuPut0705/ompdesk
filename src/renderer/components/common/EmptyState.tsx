/**
 * EmptyState — what a surface shows when it has nothing yet, and the way
 * forward: icon, one-line title, one or two sentences, then the action
 * (usually one primary Button, optionally a secondary). Every empty state
 * that the user can fix MUST offer the fixing action ("Connect GitHub",
 * "New session") — a sentence alone is a dead end.
 *
 * One component for every place a list can be empty, in three sizes:
 * - `md` (default) fills a page, a column or a list's detail pane.
 * - `sm` a panel, a dialog's body, a list inside a sheet: centred, smaller.
 * - `row` one left-aligned line inside a list of rows (a Settings list with no
 *   entries yet): the icon, the title in the muted colour, the description
 *   behind an (i) glyph (`SettingInfo`: hover, keyboard focus, a tap) when it
 *   is a string, and the action at the row's end, at a row's height.
 *
 * `id` and `data-*` attributes reach the outer element (a deep link's
 * target, a test hook).
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";
import { SettingInfo } from "./SettingInfo";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface EmptyStateProps extends DataAttributes {
	icon?: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	/** Buttons; primary first. */
	actions?: ReactNode;
	size?: "row" | "sm" | "md";
	id?: string;
	className?: string;
}

export function EmptyState({
	icon,
	title,
	description,
	actions,
	size = "md",
	id,
	className,
	...data
}: EmptyStateProps) {
	if (size === "row") {
		return (
			<div
				{...data}
				className={cx("flex min-h-(--sc-control-md) min-w-0 items-center gap-2 py-0.5", className)}
				data-empty-state="row"
				id={id}
			>
				{icon && (
					<span
						aria-hidden
						className="flex size-(--sc-icon-lg) shrink-0 items-center justify-center text-(--sc-text-muted) [&>svg]:size-(--sc-icon-md)"
					>
						{icon}
					</span>
				)}
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<span className="min-w-0 text-sc-md font-medium break-keep text-(--sc-text-muted)">{title}</span>
					{typeof description === "string" ? (
						<SettingInfo text={description} />
					) : (
						description && <span className="min-w-0 text-sc-xs text-(--sc-text-muted)">{description}</span>
					)}
				</span>
				{actions && (
					<div className="flex shrink-0 items-center gap-2" data-empty-actions>
						{actions}
					</div>
				)}
			</div>
		);
	}
	const small = size === "sm";
	return (
		<div
			{...data}
			className={cx(
				"flex flex-col items-center justify-center text-center",
				small ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12",
				className,
			)}
			data-empty-state={size}
			id={id}
		>
			{icon && (
				<span
					aria-hidden
					className={cx(
						"flex items-center justify-center rounded-(--sc-radius-lg) bg-(--sc-surface-3) text-(--sc-text-muted)",
						small ? "size-8 [&>svg]:size-(--sc-icon-md)" : "size-10 [&>svg]:size-(--sc-icon-lg)",
					)}
				>
					{icon}
				</span>
			)}
			{/* Title and sentence read as one unit; the icon and the action keep their distance. */}
			<div className="flex max-w-md flex-col items-center gap-1 break-keep">
				<div className={cx("font-semibold text-balance text-(--sc-text)", small ? "text-sc-md" : "text-sc-lg")}>
					{title}
				</div>
				{description && (
					<p className={cx("text-pretty text-(--sc-text-muted)", small ? "text-sc-sm" : "text-sc-md")}>
						{description}
					</p>
				)}
			</div>
			{actions && (
				<div className="mt-1 flex flex-wrap items-center justify-center gap-2" data-empty-actions>
					{actions}
				</div>
			)}
		</div>
	);
}
