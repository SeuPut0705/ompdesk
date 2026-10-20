/**
 * The work board's building blocks (WorkBoard.tsx and every section beside it): a state dot, a folding section and a
 * one-line row. Look in styles/work-board.css.
 */
import { ChevronRight } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useT } from "../../../lib/i18n";
import { useWorkBoardStore, type WorkBoardSectionId } from "../../../stores/work-board";

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

/** One row: a lead mark, a label that truncates, a muted figure and an optional second line. */
export function BoardRow({
	lead,
	label,
	meta,
	sub,
	onClick,
	title,
	data,
	exiting = false,
}: {
	lead: ReactNode;
	label: ReactNode;
	meta?: ReactNode;
	sub?: ReactNode;
	onClick?: () => void;
	title?: string;
	data?: Record<string, string>;
	exiting?: boolean;
}) {
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
				</div>
			)}
		</li>
	);
}
