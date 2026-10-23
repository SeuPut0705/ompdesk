import type { ButtonHTMLAttributes, ReactNode } from "react";
import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";

/** Actions stay owned by the view; the container supplies a slim view-toolbar slot. */
export const PanelActionsContext = createContext<HTMLElement | null>(null);

export function PanelActions({ children }: { children: ReactNode }) {
	const target = useContext(PanelActionsContext);
	const actions = <div className="no-drag flex shrink-0 items-center gap-0.5">{children}</div>;
	return target ? createPortal(actions, target) : actions;
}

export function PanelToolbar({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cx(
				"flex min-h-(--sc-space-10) shrink-0 flex-wrap items-center gap-2 border-b border-(--sc-divider) px-3 py-2",
				className,
			)}
		>
			{children}
		</div>
	);
}

export const PANEL_ROW_SURFACE =
	"min-h-(--sc-control-sm) rounded-(--sc-radius-sm) px-2 py-1.5 text-left text-sc-sm text-(--sc-text) transition-colors duration-(--sc-duration-fast) hover:bg-(--sc-hover) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-offset-(--sc-focus-offset) focus-visible:outline-(--sc-focus-ring)";
export const PANEL_ROW = `flex w-full items-center gap-2 ${PANEL_ROW_SURFACE}`;

/** A row of a panel's list; the one whose detail shows is `aria-current` (the list's current item, not a pressed toggle). */
export function PanelListRow({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			{...props}
			type="button"
			className={cx(PANEL_ROW, props["aria-current"] && "bg-(--sc-selected)", className)}
		/>
	);
}

export function ChangeCounts({ added, removed }: { added?: number; removed?: number }) {
	if (added === undefined || removed === undefined) return null;
	return (
		<span className="flex shrink-0 gap-1.5 text-sc-xs tabular-nums">
			<span className="text-(--sc-success)">+{added}</span>
			<span className="text-(--sc-danger)">−{removed}</span>
		</span>
	);
}
