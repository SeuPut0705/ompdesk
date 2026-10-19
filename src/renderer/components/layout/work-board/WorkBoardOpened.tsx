/**
 * The work board's rows for the sessions an agent opened: the review queue's exceptions and the children list. Loaded
 * on demand by `WorkBoard.tsx` (the phone's first screen never needs them).
 */
import { Check, X } from "lucide-react";
import { useState } from "react";
import type { AgentReviewItem } from "../../../../shared/agent-control";
import { formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useAgentReviewStore } from "../../../stores/agent-review";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import { Button } from "../../common";
import type { OpenedChildCounts, OpenedChildRow } from "./opened-children";
import { BoardRow, BoardSection, Dot } from "./WorkBoard";

/**
 * A session this one's agent opened, once it has finished (or while it still runs): its branch and diff stat, and the
 * person's choices: Review (show its changes), Approve (merge the branch into this checkout; accept a session without
 * one), Discard (close it and remove its worktree, after a second click).
 */
function ReviewRow({ parentTabId, item }: { parentTabId: string; item: AgentReviewItem }) {
	const t = useT();
	const busy = useAgentReviewStore(state => state.busy[item.tabId] === true);
	const [armed, setArmed] = useState(false);
	const running = item.state === "running";
	const hasBranch = item.branch !== undefined;
	const act = (action: "approve" | "discard") => {
		setArmed(false);
		void useAgentReviewStore.getState().act(parentTabId, action, item.tabId);
	};
	return (
		<li className="omp-work-board-item" data-board-review={item.state} data-review-child={item.tabId}>
			<div className="omp-work-board-row">
				<span className="omp-work-board-lead">
					<Dot ring={running} tone={running ? "info" : item.state === "conflict" ? "warning" : "success"} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="flex min-w-0 items-baseline gap-2">
						<span className="min-w-0 flex-1 truncate" title={item.title}>
							{item.title || t("workBoard.review.untitled")}
						</span>
						{hasBranch && !running ? (
							<span className="omp-work-board-meta">
								{t("workBoard.review.stat", { files: item.files, added: item.added, removed: item.removed })}
							</span>
						) : null}
					</span>
					<span className="omp-work-board-sub">
						<span className="truncate">
							{running
								? t("workBoard.review.running")
								: hasBranch
									? t("workBoard.review.branch", { branch: item.branch ?? "", base: item.baseBranch ?? "—" })
									: item.answer}
						</span>
					</span>
					{item.state === "conflict" && item.note ? (
						<span className="omp-work-board-sub" data-review-conflict>
							{t("workBoard.review.conflict", { files: item.note })}
						</span>
					) : null}
					{!running && item.uncommitted > 0 ? (
						<span className="omp-work-board-sub">
							{t("workBoard.review.uncommitted", { count: item.uncommitted })}
						</span>
					) : null}
				</span>
			</div>
			{running ? null : (
				<div className="omp-work-board-actions">
					<Button
						onClick={() => {
							void useTabsStore
								.getState()
								.applyAgentView({ tabId: item.tabId, how: "focus" })
								.then(() => useUiStore.getState().setPanelTab("diff"));
						}}
						size="sm"
						variant="ghost"
					>
						{t("workBoard.review.open")}
					</Button>
					<Button
						disabled={busy}
						onClick={() => act("approve")}
						size="sm"
						title={
							hasBranch
								? t("workBoard.review.approveTitle", { branch: item.branch ?? "", base: item.baseBranch ?? "" })
								: undefined
						}
						variant="primary"
					>
						{hasBranch ? t("workBoard.review.approve") : t("workBoard.review.accept")}
					</Button>
					<Button
						disabled={busy}
						onBlur={() => setArmed(false)}
						onClick={() => (armed ? act("discard") : setArmed(true))}
						size="sm"
						title={t("workBoard.review.discardTitle")}
						variant={armed ? "danger" : "ghost"}
					>
						{armed ? t("workBoard.review.discardSure") : t("workBoard.review.discard")}
					</Button>
				</div>
			)}
		</li>
	);
}
/** A session this one's agent opened, as a child like a subagent: status, what it does now, how long, its branch. */
function OpenedRow({ row, now }: { row: OpenedChildRow; now: number }) {
	const t = useT();
	const title = row.title || t("workBoard.review.untitled");
	const status = row.status;
	const statusLabel = status ? t(`workBoard.opened.status.${status}`) : t("workBoard.opened.status.open");
	const branch = row.branch ? t("workBoard.review.branch", { branch: row.branch, base: row.base ?? "—" }) : null;
	const mergeNote = row.merge ? t(`workBoard.opened.merge.${row.merge}`) : null;
	const report = row.report
		? t("workBoard.opened.report", { kind: t(`chat.custom.mail.kind.${row.report.kind}`), text: row.report.text })
		: null;
	const note =
		status === "running" && row.step && !row.report
			? row.step
			: report && status !== "done"
				? report
				: [status === "running" ? null : statusLabel, mergeNote].filter(Boolean).join(" · ");
	const open = () => {
		if (row.tabId) void useTabsStore.getState().applyAgentView({ tabId: row.tabId, how: "focus" });
		else if (row.sessionPath)
			void useTabsStore.getState().openTab({ cwd: row.cwd, sessionPath: row.sessionPath, kind: "agent" });
	};
	return (
		<BoardRow
			data={{
				"data-board-opened": row.key,
				"data-status": status ?? "open",
				...(row.report ? { "data-board-report": row.report.kind } : {}),
			}}
			label={title}
			lead={
				status === "done" ? (
					<Check aria-hidden className="size-3 text-(--sc-success)" />
				) : status === "problem" ? (
					<X aria-hidden className="size-3 text-(--sc-danger)" />
				) : (
					<Dot
						ring={status === null}
						tone={status === "waiting" ? "warning" : status === "running" ? "info" : "muted"}
					/>
				)
			}
			meta={status === "running" && row.since ? formatElapsed(Math.max(0, now - row.since)) : undefined}
			onClick={open}
			sub={
				<>
					<span className="min-w-0 flex-1 truncate">{note}</span>
					{branch ? <span className="shrink-0 truncate">{branch}</span> : null}
				</>
			}
			title={`${title}\n${statusLabel}${branch ? `\n${branch}` : ""}`}
		/>
	);
}

export function ReviewSection({ items, parentTabId }: { items: readonly AgentReviewItem[]; parentTabId: string }) {
	const t = useT();
	return (
		<BoardSection count={items.length} id="review" title={t("workBoard.review")}>
			{items.map(item => (
				<ReviewRow item={item} key={item.tabId} parentTabId={parentTabId} />
			))}
		</BoardSection>
	);
}

export function OpenedSection({
	rows,
	counts,
	now,
}: {
	rows: readonly OpenedChildRow[];
	counts: OpenedChildCounts;
	now: number;
}) {
	const t = useT();
	return (
		<BoardSection
			aside={counts.closed > 0 ? t("workBoard.opened.closed", { count: counts.closed }) : null}
			count={rows.length}
			id="opened"
			title={t("workBoard.opened")}
			tone={counts.waiting > 0 ? "warning" : undefined}
		>
			{rows.map(row => (
				<OpenedRow key={row.key} now={now} row={row} />
			))}
		</BoardSection>
	);
}
