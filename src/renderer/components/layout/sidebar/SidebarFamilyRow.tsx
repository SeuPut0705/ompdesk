/**
 * One child of a session's family (a subagent, a session opened in a worktree, a plain opened session): ONE line,
 * 28 px on a desktop and `--sc-row-touch` (36 px on a phone) under a finger — a 16 px kind glyph, the title, and at the
 * right one status token and the age. Everything else (the status in words, the folder, the model, the progress) is
 * the tooltip; the row never grows a second line.
 */

import { Bot, Check, GitBranch, GitMerge, MemoryStick, MessageSquare, Pause, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../../lib/format";
import { Button } from "../../common";
import type { ListRowProps } from "../../common/ListRow";
import { SessionTitle } from "../../common/SessionTitle";
import { WorkingArc } from "../../common/WorkingArc";
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
				// The working arc, the same one a top-level row wears in its age slot.
				<WorkingArc state="turn" />
			) : state === "waiting" ? (
				<TriangleAlert className="size-(--sc-icon-sm) text-(--sc-warning)" />
			) : state === "queued" ? (
				<MemoryStick className="size-(--sc-icon-sm) text-(--sc-text-muted)" />
			) : state === "done" ? (
				<Check className="size-(--sc-icon-sm) text-(--sc-success)" />
			) : state === "failed" ? (
				<X className="size-(--sc-icon-sm) text-(--sc-danger)" />
			) : state === "unmerged" ? (
				<GitMerge className="size-(--sc-icon-sm) text-(--sc-info)" />
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
	/** The automatic title beside a title the person set (`SessionTitle`); absent for a name that stands alone. */
	auto?: string;
	/** Whole units only ("12s", "10m", "2h", or the sidebar's time ago, a ticking `TimeAgo`). */
	age?: ReactNode;
	/** The paired device a session runs on, by name: a short muted label before the token. */
	device?: string;
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
	/**
	 * Its start waits for memory (`state` "queued"): the row says so in words, as flat rows do, with the owner's Start
	 * now; the words take the age's place, so the row stays one line.
	 */
	memoryWait?: { label: string; startNow?: { label: string; onClick: () => void } };
}

export function FamilyRow({
	kind,
	kindLabel,
	state,
	stateLabel,
	title,
	auto,
	age,
	device,
	tooltip,
	selected,
	indent,
	onOpen,
	rowProps,
	buttonProps,
	connector,
	memoryWait,
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
					className="min-w-0 flex-1 truncate text-left text-sc-sm text-(--sc-text-muted) after:absolute after:inset-0 after:rounded-(--sc-radius-md) focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-(--sc-focus-ring)"
					onClick={onOpen}
					title={tooltip}
					type="button"
				>
					{auto ? <SessionTitle noTooltip parts={{ title, auto }} /> : title}
					<span className="sr-only">
						, {kindLabel}
						{state ? `, ${stateLabel}` : ""}
					</span>
				</button>
				{device && (
					<span className="max-w-[8em] shrink-0 truncate text-sc-xs text-(--sc-text-subtle)" data-family-device>
						{device}
					</span>
				)}
				{state && <FamilyStatus state={state} />}
				{memoryWait ? (
					<>
						<span className="shrink-0 text-sc-xs text-(--sc-text-muted)" data-family-memory-wait>
							{memoryWait.label}
						</span>
						{memoryWait.startNow && (
							<Button
								className="relative z-[1]"
								data-family-start-now
								onClick={memoryWait.startNow.onClick}
								size="sm"
								variant="ghost"
							>
								{memoryWait.startNow.label}
							</Button>
						)}
					</>
				) : (
					age && <span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-subtle)">{age}</span>
				)}
			</div>
		</div>
	);
}
