/**
 * The work board's building blocks (WorkBoard.tsx and every section beside it): a state dot, a kind icon, a folding
 * section and a one-line row. Look in styles/work-board.css.
 */
import { ChevronRight, type LucideIcon, Network } from "lucide-react";
import { createContext, type ReactNode, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/** The zones a person opened (true) or closed (false) since the strip's panel opened. */
export type ZoneOpen = Partial<Record<WorkBoardSectionId, boolean>>;

interface SummaryScope {
	open: ZoneOpen;
	/** The docked board's folds as they were when the panel opened. */
	folded: Readonly<Partial<Record<WorkBoardSectionId, true>>>;
	set: (id: WorkBoardSectionId, open: boolean) => void;
}

const SummaryContext = createContext<SummaryScope | null>(null);

/**
 * The strip panel's board (WorkBoardChip holds `open` and `folded` for one open of the panel). A zone with a summary
 * line starts closed; Needs you starts open; any other zone starts as the docked board's fold was when the panel
 * opened (`folded`, a snapshot: another pane folding it later leaves this open alone). The folds are only read, so
 * `workBoardCollapsed` never changes from the strip.
 */
export function SummaryBoard({
	open,
	folded,
	onChange,
	children,
}: {
	open: ZoneOpen;
	folded: SummaryScope["folded"];
	onChange: (id: WorkBoardSectionId, open: boolean) => void;
	children: ReactNode;
}) {
	const scope = useMemo<SummaryScope>(() => ({ open, folded, set: onChange }), [open, folded, onChange]);
	return <SummaryContext.Provider value={scope}>{children}</SummaryContext.Provider>;
}

/** How long a zone just opened keeps itself in view while its rows still arrive (a lazy chunk's). */
const FOLLOW_MS = 1000;

function scrollIntoStripBody(zone: HTMLElement): void {
	const body = zone.closest<HTMLElement>(".omp-work-strip-body");
	if (!body) return;
	const box = zone.getBoundingClientRect();
	const view = body.getBoundingClientRect();
	const by = Math.min(box.top - view.top, box.bottom - view.bottom);
	if (by > 0) body.scrollTop += by;
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
	summary,
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
	/**
	 * Inside a `SummaryBoard`: the zone's one line while closed, its lead item's words and its figure in the head; a tap
	 * opens it in place.
	 */
	summary?: { lead: string; count?: ReactNode };
	children: ReactNode;
}) {
	const t = useT();
	const headId = useId();
	const scope = useContext(SummaryContext);
	const stored = useWorkBoardStore(state => state.collapsed[id] === true);
	const open = scope
		? (scope.open[id] ?? (summary === undefined && (id === "needs" || scope.folded[id] !== true)))
		: !stored;
	const zone = useRef<HTMLElement>(null);
	const opening = useRef(false);
	const toggle = () => {
		if (!scope) return useWorkBoardStore.getState().toggle(id);
		opening.current = !open;
		scope.set(id, !open);
	};
	useLayoutEffect(() => {
		const element = zone.current;
		if (!open || !opening.current || !element) return;
		opening.current = false;
		scrollIntoStripBody(element);
		if (typeof ResizeObserver !== "function") return;
		const grown = new ResizeObserver(() => scrollIntoStripBody(element));
		grown.observe(element);
		const stop = window.setTimeout(() => grown.disconnect(), FOLLOW_MS);
		return () => {
			grown.disconnect();
			window.clearTimeout(stop);
		};
	}, [open]);
	const folded = !open;
	const line = scope && folded ? summary : undefined;
	return (
		<section
			aria-labelledby={headId}
			className="omp-work-board-section omp-fade-up"
			data-board-section={id}
			data-tone={tone}
			ref={zone}
		>
			<h3 className="omp-work-board-title" id={headId}>
				{/* controls-ok: the omp-work-board-fold class draws the whole row */}
				<button
					aria-expanded={!folded}
					className="omp-work-board-fold"
					data-board-summary={line ? id : undefined}
					onClick={toggle}
					title={t(folded ? "workBoard.expand" : "workBoard.collapse", { section: title })}
					type="button"
				>
					<ChevronRight aria-hidden className="omp-work-board-chevron" data-open={!folded || undefined} />
					<span className={mid || line ? "omp-work-board-zone-title" : "truncate"}>{title}</span>
					{line ? <span className="omp-work-board-summary">{line.lead}</span> : mid}
					{line ? (
						line.count !== undefined && <span className="omp-work-board-count">{line.count}</span>
					) : count !== undefined ? (
						<span className="omp-work-board-count">{count}</span>
					) : null}
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
	/** Colour only for a state that needs the person; absent is the muted word (the bot's task states). */
	tone?: "warning" | "danger";
}

/**
 * One row: a lead mark, a label that truncates, a muted figure and an optional second line. A row may end in its own
 * buttons (`action`: a backlog item's ✕, a follow-up's pin, a pull request's link, a task's Stop); with `onClick` too,
 * the rest of the row is one button and the actions sit beside it.
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
	onClick?: () => void;
	action?: ReactNode;
}) {
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
			{onClick && action ? (
				<div className="omp-work-board-row omp-work-board-row--split" {...data}>
					{/* controls-ok: the omp-work-board-row-main class draws the row's own part */}
					<button className="omp-work-board-row-main" onClick={onClick} title={title} type="button">
						{body}
					</button>
					{action}
				</div>
			) : onClick ? (
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
