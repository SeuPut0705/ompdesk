/**
 * The sessions this one's agent opened that are still at work, in the transcript: one line each with the child's title,
 * what it does now (its step, the question it waits on) and its clock, so the main view says what is happening without
 * opening the work board. The live work card shows them while the parent's agent waits on its children
 * (`ompdesk_session_result`); between the parent's turns the transcript's status row does. Same rows and live steps as
 * the board's "Child sessions" (`useOpenedChildren`, main's review push); nothing polls beyond the board's own ask.
 */
import { useMemo } from "react";
import { useLiveReview } from "../../../hooks/use-live-review";
import { useOpenedChildren } from "../../../hooks/use-opened-children";
import { cx, formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import type { ToolEntry } from "../../../stores/tools";
import { childActivity, type OpenedChildRow } from "../../layout/work-board/opened-children";

/** The control tool whose `wait` blocks the parent's turn on its children, called directly or as stock's `xd://` device. */
const CHILDREN_WAIT_TOOL = "ompdesk_session_result";

/** A running call of the parent's agent that waits on the sessions it opened. */
export function waitsOnChildren(entry: ToolEntry | undefined): boolean {
	if (!entry || (entry.status !== "running" && entry.status !== "pending")) return false;
	return (
		entry.toolName === CHILDREN_WAIT_TOOL ||
		(entry.toolName === "write" && entry.args.path === `xd://${CHILDREN_WAIT_TOOL}`)
	);
}

/** This tab's children that run or wait on an answer: the ones still at work. */
export function useChildrenAtWork(): { tabId: string | null; rows: OpenedChildRow[] } {
	const runtimeTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const tabId = runtimeTabId ?? activeTabId;
	const { rows } = useOpenedChildren(tabId);
	const atWork = useMemo(
		() => rows.filter(row => row.tabId !== null && (row.status === "running" || row.status === "waiting")),
		[rows],
	);
	return { tabId, rows: atWork };
}

function ChildLine({ row, now }: { row: OpenedChildRow; now: number }) {
	const t = useT();
	const title = row.title || t("workBoard.review.untitled");
	const activity = childActivity(row) ?? (row.status === "waiting" ? t("workBoard.opened.status.waiting") : null);
	const clock = row.status === "running" && row.since ? formatElapsed(Math.max(0, now - row.since)) : "";
	return (
		<li>
			<button
				className="omp-children-at-work-row"
				data-child-at-work={row.key}
				data-status={row.status ?? "open"}
				onClick={() => {
					if (row.tabId) void useTabsStore.getState().applyAgentView({ tabId: row.tabId, how: "focus" });
				}}
				title={[title, activity].filter(Boolean).join("\n")}
				type="button"
			>
				<span aria-hidden className="omp-children-at-work-dot" data-status={row.status ?? "open"} />
				<span className="omp-children-at-work-title">{title}</span>
				{activity ? <span className="omp-children-at-work-step">{activity}</span> : null}
				{clock ? <span className="omp-children-at-work-clock">{clock}</span> : null}
			</button>
		</li>
	);
}

export function ChildrenAtWork({ className }: { className?: string }) {
	const t = useT();
	const { tabId, rows } = useChildrenAtWork();
	const running = rows.some(row => row.status === "running");
	useLiveReview(tabId, running);
	const now = useNowTick(running);
	if (rows.length === 0) return null;
	return (
		<section
			aria-label={t("workBoard.opened")}
			className={cx("omp-children-at-work", className)}
			data-children-at-work
		>
			<ul>
				{rows.map(row => (
					<ChildLine key={row.key} now={now} row={row} />
				))}
			</ul>
		</section>
	);
}
