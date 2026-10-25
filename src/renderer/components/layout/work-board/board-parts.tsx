/**
 * The work board's building blocks (WorkBoard.tsx and every section beside it): a state dot, a kind icon, a folding
 * section and a one-line row. Look in styles/work-board.css.
 */
import { ChevronRight, type LucideIcon, Network } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { translate, useT } from "../../../lib/i18n";
import { revealAndFocus } from "../../../lib/reveal-focus";
import { useUiStore } from "../../../stores/ui";
import { useWorkBoardStore, type WorkBoardSectionId } from "../../../stores/work-board";
import { IconButton } from "../../common";

/**
 * A running row's clock: nothing in the first ten seconds, ten-second steps under a minute, then whole minutes, so a
 * column of running clocks moves a few times a minute instead of every second.
 */
export function elapsedLabel(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (!(seconds >= 10)) return "";
	if (seconds < 60) return translate("time.secondsShort", { count: seconds - (seconds % 10) });
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return translate("time.minutesShort", { count: minutes });
	return translate("time.hoursMinutesShort", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * Rows a section lists before the rest fold into one "+N more" row; a tap shows them all until the section remounts.
 * The board stays a glance in every environment: a waiting question, the running work and a failure stay above the
 * fold even beside a long plan. The plan folds its own rest (todoBoard), so it has no entry here.
 */
export const SECTION_CAP = { asks: 3, running: 4, children: 3, followups: 3 } as const;

/**
 * The first `cap` of `items`, then one row naming how many more there are; a tap on it lists the rest. `total` counts
 * items not loaded yet as hidden too, and `onExpand` is told of the tap so it can load them; when that load fails the
 * row comes back, so the person can try again.
 */
export function CappedRows<T>({
	items,
	cap,
	total = items.length,
	onExpand,
	children,
}: {
	items: readonly T[];
	cap: number;
	total?: number;
	onExpand?: () => void | Promise<unknown>;
	children: (item: T) => ReactNode;
}) {
	const t = useT();
	const [all, setAll] = useState(false);
	const shown = all || Math.max(items.length, total) <= cap ? items : items.slice(0, cap);
	const hidden = all ? 0 : Math.max(items.length, total) - shown.length;
	return (
		<>
			{shown.map(children)}
			{hidden > 0 && (
				<li className="omp-work-board-item">
					{/* controls-ok: the omp-work-board-more class draws the whole row */}
					<button
						className="omp-work-board-more"
						data-board-more={hidden}
						onClick={event =>
							revealAndFocus(event.currentTarget, () => {
								setAll(true);
								Promise.resolve(onExpand?.()).catch(() => setAll(false));
							})
						}
						type="button"
					>
						{t("workBoard.moreTodos", { count: hidden })}
					</button>
				</li>
			)}
		</>
	);
}

export function Dot({
	tone,
	ring = false,
}: {
	tone: "info" | "success" | "warning" | "danger" | "muted";
	ring?: boolean;
}) {
	return <span aria-hidden className="omp-work-board-dot" data-ring={ring || undefined} data-tone={tone} />;
}

/**
 * A row's lead mark when the kind of thing (subagent, job, file, branch…) is the information: an icon tinted by its
 * state. A dot (`Dot`) is for rows whose state is all there is to say.
 */
export function KindMark({
	icon: Icon,
	tone = "muted",
}: {
	icon: LucideIcon;
	tone?: "info" | "success" | "warning" | "danger" | "muted";
}) {
	return <Icon aria-hidden className="omp-work-board-kind" data-tone={tone} />;
}

export function BoardSection({
	id,
	title,
	count,
	aside,
	mid,
	action,
	tone,
	live,
	children,
}: {
	id: WorkBoardSectionId;
	/** Announced politely whenever it changes (the Needs you section only). */
	live?: string;
	title: string;
	count?: ReactNode;
	aside?: ReactNode;
	/** Between the title and the right end of the head's fold button: the plan's bar. */
	mid?: ReactNode;
	/** A control of its own after the fold button (the work tree's icon button). */
	action?: ReactNode;
	tone?: "warning" | "danger";
	children: ReactNode;
}) {
	const t = useT();
	const headId = useId();
	const folded = useWorkBoardStore(state => state.collapsed[id] === true);
	return (
		<section
			aria-labelledby={headId}
			className="omp-work-board-section omp-fade-up"
			data-board-section={id}
			data-tone={tone}
		>
			<h3 className="omp-work-board-title" id={headId}>
				{/* controls-ok: the omp-work-board-fold class draws the whole row */}
				<button
					aria-expanded={!folded}
					className="omp-work-board-fold"
					onClick={() => useWorkBoardStore.getState().toggle(id)}
					title={t(folded ? "workBoard.expand" : "workBoard.collapse", { section: title })}
					type="button"
				>
					<ChevronRight aria-hidden className="omp-work-board-chevron" data-open={!folded || undefined} />
					<span className={mid ? "omp-work-board-zone-title" : "truncate"}>{title}</span>
					{mid}
					{count !== undefined && <span className="omp-work-board-count">{count}</span>}
				</button>
				{action}
				{aside ? <span className="omp-work-board-aside">{aside}</span> : null}
			</h3>
			{live ? (
				<span aria-live="polite" className="sr-only" role="status">
					{live}
				</span>
			) : null}
			{folded ? null : <ul className="omp-work-board-list">{children}</ul>}
		</section>
	);
}

/**
 * The Work tree sheet (every family of the window, finished children and unused worktrees too) is an action of the
 * sessions this one opened, not a status row: an icon button in the head of the section that lists them.
 */
export function WorkTreeButton() {
	const t = useT();
	return (
		<IconButton
			className="omp-work-board-action"
			data-board-work-tree=""
			icon={<Network />}
			label={t("workBoard.opened.workTree")}
			onClick={() => useUiStore.getState().openViewSheet("work")}
			size="sm"
		/>
	);
}

/** What a row of Needs you is, in a word of fixed width before its label. */
export interface RowTag {
	word: string;
	tone: "warning" | "danger";
}

/**
 * One row: a lead mark, a label that truncates, a muted figure and an optional second line. A row that is not itself a
 * button may end in its own button (`action`: a backlog item's ✕, a follow-up's pin, a pull request's link).
 */
export function BoardRow({
	lead,
	label,
	meta,
	sub,
	onClick,
	action,
	title,
	data,
	exiting = false,
	tag,
}: {
	lead: ReactNode;
	label: ReactNode;
	meta?: ReactNode;
	sub?: ReactNode;
	title?: string;
	data?: Record<string, string>;
	exiting?: boolean;
	/** Needs you's rows say what kind of thing they are, in a word of fixed width before the label ("Ask", "Check"). */
	tag?: RowTag;
} & ({ onClick?: () => void; action?: never } | { onClick?: never; action?: ReactNode })) {
	const body = (
		<>
			<span className="omp-work-board-lead">{lead}</span>
			{/* The text column never outgrows the row: a long branch, path or title truncates instead of widening the board. */}
			<span className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<span className="flex min-w-0 items-baseline gap-2">
					{tag ? (
						<span className="omp-work-board-tag" data-tone={tag.tone}>
							{tag.word}
						</span>
					) : null}
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{meta ? <span className="omp-work-board-meta">{meta}</span> : null}
				</span>
				{sub ? <span className="omp-work-board-sub">{sub}</span> : null}
			</span>
		</>
	);
	return (
		<li aria-hidden={exiting || undefined} className="omp-work-board-item" data-exiting={exiting || undefined}>
			{onClick ? (
				// controls-ok: the omp-work-board-row class draws the whole row
				<button className="omp-work-board-row" onClick={onClick} title={title} type="button" {...data}>
					{body}
				</button>
			) : (
				<div className="omp-work-board-row" title={title} {...data}>
					{body}
					{action}
				</div>
			)}
		</li>
	);
}
