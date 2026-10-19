/**
 * One child of a session's family (a subagent, a session opened in a worktree, a plain opened session): ONE line,
 * 28 px on a desktop and `--sc-row-touch` (36 px on a phone) under a finger — a 16 px kind glyph, the title, and at the
 * right one status token and the age. Everything else (the status in words, the folder, the model, the progress) is
 * the tooltip; the row never grows a second line.
 */

import { Bot, Check, GitBranch, MessageSquare, Pause, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../../lib/format";
import type { ListRowProps } from "../../common/ListRow";
import type { FamilyKind, FamilyState } from "./sidebar-family";

const KIND_ICON = { subagent: Bot, worktree: GitBranch, session: MessageSquare } as const;

/** The token at the right of a row. Colour never says it alone (the glyph differs); the button's own text names the state. */
export function FamilyStatus({ state }: { state: FamilyState }) {
	return (
		<span
			aria-hidden
			className="flex size-(--sc-icon-md) shrink-0 items-center justify-center"
			data-family-status={state}
		>
			{state === "running" ? (
				<span className="size-2 rounded-(--sc-radius-full) bg-(--sc-accent)" />
			) : state === "waiting" ? (
				<TriangleAlert className="size-(--sc-icon-sm) text-(--sc-warning)" />
			) : state === "done" ? (
				<Check className="size-(--sc-icon-sm) text-(--sc-success)" />
			) : state === "failed" ? (
				<X className="size-(--sc-icon-sm) text-(--sc-danger)" />
			) : (
				<Pause className="size-(--sc-icon-sm) text-(--sc-text-subtle)" />
			)}
		</span>
	);
}

export interface FamilyRowProps {
	kind: FamilyKind;
	/** Words for the kind glyph, read by screen readers. */
	kindLabel: string;
	/** Null: no token (a session that is merely open). */
	state: FamilyState | null;
	stateLabel: string;
	title: string;
	/** Whole units only ("12s", "10m", "2h", or the sidebar's time ago). */
	age?: string;
	/** Native tooltip: the status, folder, model, progress — whatever the one line has no room for. */
	tooltip: string;
	selected: boolean;
	/** Padding class that sets the row's indent (the glyph column starts one icon step right of the parent's). */
	indent: string;
	onOpen: () => void;
	rowProps?: ListRowProps["rowProps"];
	buttonProps?: ListRowProps["buttonProps"];
	/** The tree connector of a nested child, drawn behind the row. */
	connector?: ReactNode;
}

export function FamilyRow({
	kind,
	kindLabel,
	state,
	stateLabel,
	title,
	age,
	tooltip,
	selected,
	indent,
	onOpen,
	rowProps,
	buttonProps,
	connector,
}: FamilyRowProps) {
	const Icon = KIND_ICON[kind];
	return (
		<div className="relative">
			{connector}
			<div
				{...rowProps}
				className={cx(
					"omp-family-row group/row relative flex w-full items-center gap-1.5 rounded-(--sc-radius-md) pr-2.5",
					indent,
					selected ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
				)}
				data-family-kind={kind}
				data-family-state={state ?? undefined}
			>
				<span
					aria-hidden
					className="flex size-(--sc-icon-md) shrink-0 items-center justify-center text-(--sc-text-subtle)"
					data-family-glyph={kind}
				>
					<Icon className="size-(--sc-icon-md)" />
				</span>
				<button
					{...buttonProps}
					aria-current={selected ? "true" : undefined}
					className="min-w-0 flex-1 truncate text-left text-sc-sm text-(--sc-text-muted) outline-none after:absolute after:inset-0 after:rounded-(--sc-radius-md) focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-(--sc-focus-ring)"
					onClick={onOpen}
					title={tooltip}
					type="button"
				>
					{title}
					<span className="sr-only">
						, {kindLabel}
						{state ? `, ${stateLabel}` : ""}
					</span>
				</button>
				{state && <FamilyStatus state={state} />}
				{age && <span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-subtle)">{age}</span>}
			</div>
		</div>
	);
}
