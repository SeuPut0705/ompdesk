import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Tooltip } from "../common";

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
	"min-h-(--sc-control-sm) rounded-(--sc-radius-sm) px-2 py-1.5 text-left text-sc-sm text-(--sc-text) transition-colors duration-(--sc-duration-fast) ease-(--sc-ease-standard) hover:bg-(--sc-hover) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-offset-(--sc-focus-offset) focus-visible:outline-(--sc-focus-ring)";

/** A changed file's git state, as the Changes list and a commit's file list say it. */
export type ChangeStatusName = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";
const CHANGE_STATUS: Record<ChangeStatusName, { letter: string; color: string }> = {
	modified: { letter: "M", color: "text-(--sc-warning)" },
	added: { letter: "A", color: "text-(--sc-success)" },
	untracked: { letter: "U", color: "text-(--sc-success)" },
	deleted: { letter: "D", color: "text-(--sc-danger)" },
	renamed: { letter: "R", color: "text-(--sc-text-muted)" },
	conflicted: { letter: "C", color: "text-(--sc-danger)" },
};

/** The state's letter at a file row's end, its word in the tooltip (hover, focus, a tap); the row's own name says it too. */
export function ChangeStatus({ status }: { status: ChangeStatusName }) {
	const t = useT();
	const mark = CHANGE_STATUS[status];
	const word = t(`diffPanel.status.${status}`);
	return (
		<Tooltip content={word} describe={false}>
			<span
				aria-label={word}
				className={`w-3 shrink-0 rounded-(--sc-radius-sm) text-center font-mono text-sc-xs ${mark.color}`}
				data-change-status={status}
				role="img"
				tabIndex={0}
			>
				{mark.letter}
			</span>
		</Tooltip>
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
