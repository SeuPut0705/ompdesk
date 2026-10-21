/**
 * EmptyState — what a surface shows when it has nothing yet, and the way
 * forward: icon, one-line title, one or two sentences, then the action
 * (usually one primary Button, optionally a secondary). Every empty state
 * that the user can fix MUST offer the fixing action ("Connect GitHub",
 * "New session") — a sentence alone is a dead end.
 * `size="sm"` fits panels and lists; `md` (default) fills a page or column.
 */

import type { ReactNode } from "react";
import { cx } from "../../lib/format";

export interface EmptyStateProps {
	icon?: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	/** Buttons; primary first. */
	actions?: ReactNode;
	size?: "sm" | "md";
	className?: string;
}

export function EmptyState({ icon, title, description, actions, size = "md", className }: EmptyStateProps) {
	const small = size === "sm";
	return (
		<div
			className={cx(
				"flex flex-col items-center justify-center text-center",
				small ? "gap-2 px-4 py-6" : "gap-3 px-6 py-12",
				className,
			)}
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
