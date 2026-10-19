/**
 * The work board's rows for the sessions an agent opened: status only (working, waiting, failed), no buttons. The
 * opener's agent reviews and lands its children with its tools; a click on a row focuses the child. Loaded on demand
 * by `WorkBoard.tsx` (the phone's first screen never needs them).
 */
import { Check, X } from "lucide-react";
import { formatElapsed } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useTabsStore } from "../../../stores/tabs";
import type { OpenedChildCounts, OpenedChildRow } from "./opened-children";
import { BoardRow, BoardSection, Dot } from "./WorkBoard";

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
		>
			{rows.map(row => (
				<OpenedRow key={row.key} now={now} row={row} />
			))}
		</BoardSection>
	);
}
