/**
 * The work board's building blocks (WorkBoard.tsx and every section beside it): a state dot, a folding section and a
 * one-line row. Look in styles/work-board.css.
 */
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useT } from "../../../lib/i18n";
import { revealAndFocus } from "../../../lib/reveal-focus";
import { useWorkBoardStore, type WorkBoardSectionId } from "../../../stores/work-board";

/**
 * Rows a section lists before the rest fold into one "+N more" row; a tap shows them all until the section remounts.
 * The board stays a glance in every environment: a waiting question, the running work and a failure stay above the
 * fold even beside a long plan. The plan folds its own rest (todoBoard), so it has no entry here.
 */
export const SECTION_CAP = { waiting: 3, running: 4, opened: 3, followups: 3 } as const;

/** The first `cap` of `items`, then one row naming how many more there are; a tap on it lists the rest. */
export function CappedRows<T>({
	items,
	cap,
	children,
}: {
	items: readonly T[];
	cap: number;
	children: (item: T) => ReactNode;
}) {
	const t = useT();
	const [all, setAll] = useState(false);
	const shown = all || items.length <= cap ? items : items.slice(0, cap);
	const hidden = items.length - shown.length;
	return (
		<>
			{shown.map(children)}
			{hidden > 0 && (
				<li className="omp-work-board-item">
					<button
						className="omp-work-board-more"
						data-board-more={hidden}
						onClick={event => revealAndFocus(event.currentTarget, () => setAll(true))}
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

export function BoardSection({
	id,
	title,
	count,
	aside,
	tone,
	live,
	children,
}: {
	id: WorkBoardSectionId;
	/** Announced politely whenever it changes (the waiting section only). */
	live?: string;
	title: string;
	count?: ReactNode;
	aside?: ReactNode;
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
				<button
					aria-expanded={!folded}
					className="omp-work-board-fold"
					onClick={() => useWorkBoardStore.getState().toggle(id)}
					title={t(folded ? "workBoard.expand" : "workBoard.collapse", { section: title })}
					type="button"
				>
					<ChevronRight aria-hidden className="omp-work-board-chevron" data-open={!folded || undefined} />
					<span className="truncate">{title}</span>
					{count !== undefined && <span className="omp-work-board-count">{count}</span>}
				</button>
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
}: {
	lead: ReactNode;
	label: ReactNode;
	meta?: ReactNode;
	sub?: ReactNode;
	title?: string;
	data?: Record<string, string>;
	exiting?: boolean;
} & ({ onClick?: () => void; action?: never } | { onClick?: never; action?: ReactNode })) {
	const body = (
		<>
			<span className="omp-work-board-lead">{lead}</span>
			{/* The text column never outgrows the row: a long branch, path or title truncates instead of widening the board. */}
			<span className="flex min-w-0 flex-1 flex-col overflow-hidden">
				<span className="flex min-w-0 items-baseline gap-2">
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
