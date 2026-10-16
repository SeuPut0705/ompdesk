import type { ReactNode } from "react";

/**
 * The one-line header on the top edge of a box (code block, figure): the
 * title on the left, icon actions on the right, `--sc-control-sm` high.
 */
export function FigureHeader({ title, children }: { title?: string; children?: ReactNode }) {
	return (
		<div
			className="flex min-h-(--sc-control-sm) items-center justify-between gap-2 border-b border-(--sc-divider) ps-3 pe-1"
			data-figure-header
		>
			{title !== undefined && (
				<span className="min-w-0 truncate text-sc-xs text-(--sc-text-muted)" data-figure-title>
					{title}
				</span>
			)}
			<div className="ms-auto flex shrink-0 items-center gap-0.5" data-figure-actions>
				{children}
			</div>
		</div>
	);
}
