/**
 * The sessions the bot opened, on its home: one line each (title, state word, what it does now), a tap opens or
 * focuses it. The rows are the work board's (`useOpenedChildren`, `BoardRow`, `childActivity`), so the home and the
 * board never disagree about a child.
 */
import { Check, GitFork, GitMerge } from "lucide-react";
import { useOpenedChildren } from "../../hooks/use-opened-children";
import { useT } from "../../lib/i18n";
import type { ChildStatus } from "../layout/sidebar/sidebar-family";
import { BoardRow, CappedRows, KindMark } from "../layout/work-board/board-parts";
import { openOpenedChild } from "../layout/work-board/open-peer";
import { childActivity, type OpenedChildRow } from "../layout/work-board/opened-children";

const LISTED = 8;

const TONES: Partial<Record<ChildStatus, "danger" | "warning" | "info">> = {
	failed: "danger",
	waiting: "warning",
	running: "info",
};

function SessionRow({ row }: { row: OpenedChildRow }) {
	const t = useT();
	const status = row.status;
	const title = row.title || t("workBoard.review.untitled");
	const state = t(`workBoard.opened.status.${status ?? "open"}`);
	const activity = childActivity(row);
	return (
		<BoardRow
			data={{ "data-bot-session": row.key, "data-status": status ?? "open" }}
			label={
				<>
					{title}
					{row.device ? <span className="text-(--sc-text-subtle)"> · {row.device}</span> : null}
				</>
			}
			lead={
				status === "done" ? (
					<Check aria-hidden className="size-3 text-(--sc-success)" />
				) : status === "unmerged" ? (
					<KindMark icon={GitMerge} tone="info" />
				) : (
					<KindMark icon={GitFork} tone={(status && TONES[status]) || "muted"} />
				)
			}
			meta={state}
			onClick={() => openOpenedChild(row)}
			sub={
				activity ? (
					<span className="min-w-0 truncate" data-bot-session-activity>
						{activity}
					</span>
				) : undefined
			}
			title={[title, state, activity].filter(Boolean).join("\n")}
		/>
	);
}

export function BotSessions({ tabId }: { tabId: string }) {
	const t = useT();
	const { rows } = useOpenedChildren(tabId);
	if (rows.length === 0)
		return (
			<p className="text-sc-sm text-(--sc-text-muted)" data-bot-sessions-empty>
				{t("botHome.sessions.empty")}
			</p>
		);
	return (
		<ul className="omp-work-board-list" data-bot-sessions>
			<CappedRows cap={LISTED} items={rows}>
				{row => <SessionRow key={row.key} row={row} />}
			</CappedRows>
		</ul>
	);
}
